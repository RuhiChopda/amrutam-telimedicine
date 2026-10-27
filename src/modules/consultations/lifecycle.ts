import { z } from 'zod';
import { AAD } from '../../shared/aad';
import { addMinutes, type Clock } from '../../shared/clock';
import type { Actor } from '../../shared/context';
import { HmacSigner, sha256, stableStringify, type FieldCrypto } from '../../shared/crypto';
import type { Db, Tx } from '../../shared/db';
import { conflict, forbidden, notFound, PG, pgCode } from '../../shared/errors';
import type { Metrics } from '../../shared/metrics';
import { cursorSchema, decodeCursor, encodeCursor, limitSchema, shortText, uuid } from '../../shared/validation';
import type { AuditService } from '../audit/service';
import type { Config } from '../../config/env';
import type { DoctorService } from '../doctors/service';
import type { JobQueue } from '../jobs/queue';
import type { BookingService, ConsultationRow, ConsultationView } from './booking';

export const completeSchema = z.strictObject({ notes: z.string().trim().max(10_000).optional() });

export const prescriptionSchema = z.strictObject({
  diagnosis: shortText(1000),
  medications: z
    .array(
      z.strictObject({
        name: shortText(200),
        dosage: shortText(100),
        frequency: shortText(100),
        durationDays: z.number().int().min(1).max(365),
        instructions: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(30),
  advice: z.string().trim().max(2000).optional(),
});
export type PrescriptionInput = z.infer<typeof prescriptionSchema>;

export const reviewSchema = z.strictObject({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1000).optional() });

export const listPrescriptionsSchema = z.strictObject({ limit: limitSchema, cursor: cursorSchema });

interface PrescriptionRow {
  id: string;
  consultation_id: string;
  patient_id: string;
  doctor_id: string;
  version: number;
  status: string;
  supersedes_id: string | null;
  content_enc: string;
  content_sha256: Buffer;
  signature: string;
  created_at: Date;
}

const START_EARLY_MINUTES = 10;

export class LifecycleService {
  private readonly signer: HmacSigner;

  constructor(
    private readonly db: Db,
    private readonly booking: BookingService,
    private readonly doctors: DoctorService,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly crypto: FieldCrypto,
    signingKey: Buffer,
    private readonly clock: Clock,
    private readonly cfg: Config,
    private readonly metrics: Metrics,
  ) {
    this.signer = new HmacSigner(signingKey);
  }

  private async doctorCtx(tx: Tx, actor: Actor, consultationId: string): Promise<ConsultationRow> {
    const c = await this.booking.lockConsultation(tx, consultationId);
    if (!c) throw notFound('Consultation');
    const doctorId = await this.doctors.doctorIdForUser(actor.id).catch(() => undefined);
    if (!doctorId || doctorId !== c.doctor_id) throw notFound('Consultation');
    return c;
  }

  /* ------------------------------------------------------------ start / complete */
  async start(actor: Actor, id: string): Promise<ConsultationView> {
    const row = await this.db.tx(async (tx) => {
      const c = await this.doctorCtx(tx, actor, id);
      if (c.status === 'IN_PROGRESS') return c; // idempotent
      if (c.status !== 'CONFIRMED') throw conflict('INVALID_STATE', `Cannot start a consultation that is ${c.status}`);
      const now = this.clock.now();
      if (now < addMinutes(c.scheduled_at, -START_EARLY_MINUTES)) throw conflict('TOO_EARLY', `A consultation can be started ${START_EARLY_MINUTES} minutes before its scheduled time`);
      if (now > c.ends_at) throw conflict('WINDOW_PASSED', 'The scheduled window has passed');
      const u = await tx.query<ConsultationRow>(
        `UPDATE consultations SET status = 'IN_PROGRESS', started_at = $2, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, now],
      );
      await this.audit.record(tx, { action: 'consultation.start', entityType: 'consultation', entityId: id });
      this.metrics.consultationTransitions.inc({ to: 'IN_PROGRESS' });
      return u.rows[0] as ConsultationRow;
    });
    return this.booking.view(row, 'doctor', true, true);
  }

  async complete(actor: Actor, id: string, notes: string | undefined): Promise<ConsultationView> {
    const row = await this.db.tx(async (tx) => {
      const c = await this.doctorCtx(tx, actor, id);
      if (c.status === 'COMPLETED') return c; // idempotent
      if (c.status !== 'IN_PROGRESS') throw conflict('INVALID_STATE', `Cannot complete a consultation that is ${c.status}`);
      const u = await tx.query<ConsultationRow>(
        `UPDATE consultations SET status = 'COMPLETED', completed_at = $2, notes_enc = $3, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, this.clock.now(), notes ? this.crypto.encrypt(notes, AAD.consultationNotes(id)) : null],
      );
      await this.audit.record(tx, { action: 'consultation.complete', entityType: 'consultation', entityId: id, metadata: { hasNotes: !!notes } });
      await this.queue.enqueue(tx, 'notify', { userId: c.patient_id, template: 'consultation.completed', data: { consultationId: id } });
      this.metrics.consultationTransitions.inc({ to: 'COMPLETED' });
      return u.rows[0] as ConsultationRow;
    });
    return this.booking.view(row, 'doctor', true, true);
  }

  /** Scheduler: CONFIRMED consultations never started within the grace period become NO_SHOW (no refund). */
  async markNoShows(batch = 200): Promise<number> {
    const cutoff = addMinutes(this.clock.now(), -this.cfg.booking.noShowGraceMinutes);
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM consultations WHERE status = 'CONFIRMED' AND ends_at < $1 LIMIT $2`,
      [cutoff, batch],
    );
    let n = 0;
    for (const { id } of rows) {
      const ok = await this.db.tx(async (tx) => {
        const c = await this.booking.lockConsultation(tx, id, true);
        if (!c || c.status !== 'CONFIRMED') return false;
        await tx.query(`UPDATE consultations SET status = 'NO_SHOW', version = version + 1 WHERE id = $1`, [id]);
        await this.audit.record(tx, { action: 'consultation.no_show', actorId: null, actorRole: 'system', entityType: 'consultation', entityId: id });
        this.metrics.consultationTransitions.inc({ to: 'NO_SHOW' });
        return true;
      });
      if (ok) n++;
    }
    return n;
  }

  /* ------------------------------------------------------------ prescriptions */
  private sigMessage(r: { id: string; consultationId: string; version: number; hash: Buffer }) {
    return `${r.id}|${r.consultationId}|${r.version}|${r.hash.toString('hex')}`;
  }

  /**
   * Creates a prescription (or a revision). Prescriptions are immutable: a revision inserts version+1 and marks the
   * previous version SUPERSEDED. Content is encrypted at rest and HMAC-signed so tampering is detectable.
   */
  async createPrescription(actor: Actor, consultationId: string, input: PrescriptionInput, tx: Tx): Promise<{ status: number; body: unknown }> {
    const c = await this.doctorCtx(tx, actor, consultationId);
    if (!['IN_PROGRESS', 'COMPLETED'].includes(c.status)) {
      throw conflict('INVALID_STATE', 'Prescriptions can only be issued for consultations in progress or completed');
    }
    const prev = (
      await tx.query<PrescriptionRow>(
        `SELECT * FROM prescriptions WHERE consultation_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [consultationId],
      )
    ).rows[0];
    const id = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]?.id as string;
    const version = (prev?.version ?? 0) + 1;
    const content = { ...input, issuedAt: this.clock.now().toISOString() };
    const hash = sha256(stableStringify(content));
    const signature = this.signer.sign(this.sigMessage({ id, consultationId, version, hash }));
    try {
      if (prev) await tx.query(`UPDATE prescriptions SET status = 'SUPERSEDED' WHERE id = $1`, [prev.id]);
      await tx.query(
        `INSERT INTO prescriptions (id, consultation_id, patient_id, doctor_id, version, supersedes_id, content_enc, content_sha256, signature)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, consultationId, c.patient_id, c.doctor_id, version, prev?.id ?? null, this.crypto.encryptJson(content, AAD.prescription(id)), hash, signature],
      );
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) throw conflict('PRESCRIPTION_CONFLICT', 'Concurrent prescription update; retry');
      throw err;
    }
    await this.audit.record(tx, { action: 'prescription.create', entityType: 'prescription', entityId: id, metadata: { consultationId, version, medications: input.medications.length } });
    await this.queue.enqueue(tx, 'notify', { userId: c.patient_id, template: 'prescription.issued', data: { consultationId, prescriptionId: id } });
    return { status: 201, body: { id, consultationId, version, status: 'ACTIVE', signature, ...content } };
  }

  private toPrescriptionView(r: PrescriptionRow) {
    const content = this.crypto.decryptJson<Record<string, unknown>>(r.content_enc, AAD.prescription(r.id));
    const intact =
      sha256(stableStringify(content)).equals(r.content_sha256) &&
      this.signer.verify(this.sigMessage({ id: r.id, consultationId: r.consultation_id, version: r.version, hash: r.content_sha256 }), r.signature);
    return {
      id: r.id,
      consultationId: r.consultation_id,
      doctorId: r.doctor_id,
      version: r.version,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      signatureValid: intact,
      ...content,
    };
  }

  async getPrescription(actor: Actor, id: string) {
    const { rows } = await this.db.query<PrescriptionRow>('SELECT * FROM prescriptions WHERE id = $1', [id]);
    const r = rows[0];
    if (!r) throw notFound('Prescription');
    await this.assertPrescriptionAccess(actor, r);
    await this.audit.recordStandalone({ action: 'prescription.read', entityType: 'prescription', entityId: id });
    return this.toPrescriptionView(r);
  }

  private async assertPrescriptionAccess(actor: Actor, r: PrescriptionRow) {
    if (actor.role === 'patient' && r.patient_id === actor.id) return;
    if (actor.role === 'doctor') {
      const d = await this.doctors.doctorIdForUser(actor.id).catch(() => undefined);
      if (d && d === r.doctor_id) return;
    }
    throw notFound('Prescription');
  }

  async listForConsultation(actor: Actor, consultationId: string) {
    const { rows } = await this.db.query<PrescriptionRow>('SELECT * FROM prescriptions WHERE consultation_id = $1 ORDER BY version DESC', [consultationId]);
    if (rows[0]) await this.assertPrescriptionAccess(actor, rows[0]);
    else {
      const c = await this.db.query<ConsultationRow>('SELECT * FROM consultations WHERE id = $1', [consultationId]);
      if (!c.rows[0] || !(await this.booking.partyOf(actor, c.rows[0]))) throw notFound('Consultation');
    }
    await this.audit.recordStandalone({ action: 'prescription.list', entityType: 'consultation', entityId: consultationId });
    return { items: rows.map((r) => this.toPrescriptionView(r)) };
  }

  async listMine(actor: Actor, q: z.infer<typeof listPrescriptionsSchema>) {
    if (actor.role !== 'patient') throw forbidden();
    const cursor = decodeCursor(q.cursor, z.strictObject({ at: z.string().datetime(), id: uuid }));
    const params: unknown[] = [actor.id];
    let cur = '';
    if (cursor) {
      params.push(cursor.at, cursor.id);
      cur = `AND (created_at, id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(q.limit + 1);
    const { rows } = await this.db.read<PrescriptionRow>(
      `SELECT * FROM prescriptions WHERE patient_id = $1 AND status = 'ACTIVE' ${cur} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    await this.audit.recordStandalone({ action: 'prescription.list', entityType: 'patient', entityId: actor.id });
    return { items: page.map((r) => this.toPrescriptionView(r)), nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.created_at.toISOString(), id: last.id }) : undefined };
  }

  /* ------------------------------------------------------------ reviews */
  async review(actor: Actor, consultationId: string, input: z.infer<typeof reviewSchema>) {
    return this.db.tx(async (tx) => {
      const c = await this.booking.lockConsultation(tx, consultationId);
      if (!c || c.patient_id !== actor.id) throw notFound('Consultation');
      if (c.status !== 'COMPLETED') throw conflict('INVALID_STATE', 'Only completed consultations can be reviewed');
      const ins = await tx.query(
        `INSERT INTO reviews (consultation_id, patient_id, doctor_id, rating, comment) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (consultation_id) DO NOTHING`,
        [consultationId, actor.id, c.doctor_id, input.rating, input.comment ?? null],
      );
      if (ins.rowCount === 0) throw conflict('ALREADY_REVIEWED', 'This consultation has already been reviewed');
      // Incremental mean: no table scan, serialised by the doctor row lock.
      await tx.query(
        `UPDATE doctors SET rating_avg = round(((rating_avg * rating_count) + $2) / (rating_count + 1), 2), rating_count = rating_count + 1 WHERE id = $1`,
        [c.doctor_id, input.rating],
      );
      await this.audit.record(tx, { action: 'review.create', entityType: 'consultation', entityId: consultationId, metadata: { rating: input.rating } });
      tx.afterCommit(() => this.doctors.invalidateDoctor(c.doctor_id));
      return { consultationId, rating: input.rating };
    });
  }
}
