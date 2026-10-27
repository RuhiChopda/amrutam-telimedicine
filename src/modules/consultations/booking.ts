import { z } from 'zod';
import type { Config } from '../../config/env';
import { AAD } from '../../shared/aad';
import type { Cache } from '../../shared/cache';
import { addMinutes, addSeconds, type Clock } from '../../shared/clock';
import type { Actor } from '../../shared/context';
import type { FieldCrypto } from '../../shared/crypto';
import type { Db, Tx } from '../../shared/db';
import { conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import type { Metrics } from '../../shared/metrics';
import { cursorSchema, decodeCursor, encodeCursor, isoDateTime, limitSchema, shortText, uuid } from '../../shared/validation';
import type { AuditService } from '../audit/service';
import type { DoctorService } from '../doctors/service';
import type { JobQueue } from '../jobs/queue';

export const bookSchema = z.strictObject({
  slotId: uuid,
  reason: shortText(1000).optional(),
});
export type BookInput = z.infer<typeof bookSchema>;

export const cancelSchema = z.strictObject({ reason: shortText(300).optional() });

export const listConsultationsSchema = z.strictObject({
  status: z.enum(['PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export const LIVE_STATUSES = ['PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS'] as const;

export interface ConsultationRow {
  id: string;
  scheduled_at: Date;
  ends_at: Date;
  slot_id: string;
  patient_id: string;
  doctor_id: string;
  specialty: string | null;
  status: string;
  cancel_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  reason_enc: string | null;
  notes_enc: string | null;
  fee_minor: number;
  currency: string;
  started_at: Date | null;
  completed_at: Date | null;
  version: number;
  created_at: Date;
}

export interface ConsultationView {
  id: string;
  status: string;
  doctorId: string;
  patientId: string;
  specialty: string | null;
  scheduledAt: string;
  endsAt: string;
  fee: { amountMinor: number; currency: string };
  reason?: string | null;
  notes?: string | null;
  cancellation?: { reason: string | null; at: string; by: string | null };
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  payment?: { id: string; status: string; expiresAt: string | null; clientSecret?: string | null } | null;
}

type Party = 'patient' | 'doctor';

/**
 * Booking saga + consultation lifecycle.
 *
 * Distributed-transaction strategy (see docs/architecture.md §Sagas): no 2PC. The local DB transaction makes the slot
 * hold, consultation and payment row atomic; the external PSP is driven by durable, idempotent jobs; every failure path
 * has an explicit compensation:
 *
 *   BOOK        slot OPEN→HELD, consultation PENDING_PAYMENT, payment PENDING, outbox job payment.create_intent
 *   PAY OK      payment SUCCEEDED, consultation CONFIRMED, slot HELD→BOOKED
 *   PAY FAILED  compensate: consultation CANCELLED, slot HELD→OPEN, payment FAILED
 *   TIMEOUT     compensate: consultation CANCELLED, slot HELD→OPEN, payment VOIDED + gateway void job
 *   LATE PAY    (success webhook after timeout) compensate: payment SUCCEEDED→REFUND_PENDING + refund job
 *   CANCEL      slot reopened (patient) or closed (doctor/admin), payment voided or refunded per policy
 *
 * All transitions lock the consultation row (SELECT … FOR UPDATE), which serialises the PAY-vs-TIMEOUT race: exactly
 * one wins, the other observes the new state and compensates.
 */
export class BookingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly queue: JobQueue,
    private readonly cache: Cache,
    private readonly doctors: DoctorService,
    private readonly crypto: FieldCrypto,
    private readonly clock: Clock,
    private readonly cfg: Config,
    private readonly metrics: Metrics,
  ) {}

  private async run<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.db.tx(fn);
  }

  private bumpSlots(tx: Tx, doctorId: string) {
    tx.afterCommit(async () => {
      await this.cache.incr(`slots:ver:${doctorId}`);
    });
  }

  private transition(to: string) {
    this.metrics.consultationTransitions.inc({ to });
  }

  /* ================================================================== BOOK */
  async book(actor: Actor, input: BookInput, tx?: Tx): Promise<{ status: number; body: ConsultationView }> {
    try {
      const out = await this.run(tx, (t) => this.bookTx(actor, input, t));
      this.metrics.bookings.inc({ outcome: 'created' });
      return out;
    } catch (err) {
      const code = (err as { code?: string }).code;
      this.metrics.bookings.inc({ outcome: code === 'SLOT_UNAVAILABLE' ? 'slot_conflict' : 'rejected' });
      throw err;
    }
  }

  private async bookTx(actor: Actor, input: BookInput, tx: Tx): Promise<{ status: number; body: ConsultationView }> {
    const now = this.clock.now();
    // Serialise one patient's concurrent bookings so the pending-limit and overlap checks below are exact.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`book:${actor.id}`]);

    const pending = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM consultations WHERE patient_id = $1 AND status = 'PENDING_PAYMENT'`,
      [actor.id],
    );
    if ((pending.rows[0]?.n ?? 0) >= this.cfg.booking.maxPendingPerPatient) {
      throw conflict('TOO_MANY_PENDING_BOOKINGS', 'Complete or cancel your pending bookings before booking more');
    }

    const holdUntil = addSeconds(now, this.cfg.booking.holdSeconds);
    // Atomic compare-and-set: OPEN → HELD. Concurrent bookers queue on the row lock; the loser re-evaluates the predicate
    // after the winner commits, sees status = 'HELD', and updates zero rows. No lost updates, no double booking.
    const claimed = await tx.query<{
      id: string;
      doctor_id: string;
      start_at: Date;
      end_at: Date;
      fee: number;
      currency: string;
      specialty: string;
    }>(
      `UPDATE availability_slots s
          SET status = 'HELD', held_by = $2, hold_expires_at = $3, version = s.version + 1
         FROM doctors d
        WHERE s.id = $1 AND s.status = 'OPEN' AND s.start_at >= $4 AND s.start_at <= $5
          AND d.id = s.doctor_id AND d.verification_status = 'VERIFIED'
        RETURNING s.id, s.doctor_id, s.start_at, s.end_at, d.consultation_fee_minor AS fee, d.currency, d.primary_specialty AS specialty`,
      [
        input.slotId,
        actor.id,
        holdUntil,
        addMinutes(now, this.cfg.booking.minLeadMinutes),
        new Date(now.getTime() + this.cfg.booking.horizonDays * 86_400_000),
      ],
    );
    const slot = claimed.rows[0];
    if (!slot) {
      const s = await tx.query<{ status: string; start_at: Date }>('SELECT status, start_at FROM availability_slots WHERE id = $1', [input.slotId]);
      if (!s.rows[0]) throw notFound('Slot');
      if (s.rows[0].status !== 'OPEN') throw conflict('SLOT_UNAVAILABLE', 'This slot is no longer available');
      throw unprocessable('SLOT_NOT_BOOKABLE', 'This slot is too soon, too far ahead, or its doctor is not currently verified');
    }

    const overlap = await tx.query(
      `SELECT 1 FROM consultations WHERE patient_id = $1 AND status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS')
          AND scheduled_at < $3 AND ends_at > $2 LIMIT 1`,
      [actor.id, slot.start_at, slot.end_at],
    );
    if (overlap.rowCount) throw conflict('PATIENT_DOUBLE_BOOKED', 'You already have a consultation at this time');

    const free = slot.fee === 0;
    const reasonId = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]?.id as string;
    const c = await tx.query<ConsultationRow>(
      `INSERT INTO consultations (id, scheduled_at, ends_at, slot_id, patient_id, doctor_id, specialty, status, reason_enc, fee_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        reasonId,
        slot.start_at,
        slot.end_at,
        slot.id,
        actor.id,
        slot.doctor_id,
        slot.specialty,
        free ? 'CONFIRMED' : 'PENDING_PAYMENT',
        input.reason ? this.crypto.encrypt(input.reason, AAD.consultationReason(reasonId)) : null,
        slot.fee,
        slot.currency,
      ],
    );
    const row = c.rows[0] as ConsultationRow;

    let payment: ConsultationView['payment'] = null;
    if (free) {
      await tx.query(`UPDATE availability_slots SET status = 'BOOKED', held_by = NULL, hold_expires_at = NULL WHERE id = $1`, [slot.id]);
      await this.notify(tx, row, 'booking.confirmed');
      this.transition('CONFIRMED');
    } else {
      const p = await tx.query<{ id: string }>(
        `INSERT INTO payments (consultation_id, patient_id, amount_minor, currency, status, provider, expires_at)
         VALUES ($1,$2,$3,$4,'PENDING','mock',$5) RETURNING id`,
        [row.id, actor.id, slot.fee, slot.currency, holdUntil],
      );
      const paymentId = (p.rows[0] as { id: string }).id;
      // Transactional outbox: the job exists iff the booking committed.
      await this.queue.enqueue(tx, 'payment.create_intent', { paymentId }, { dedupeKey: `create_intent:${paymentId}` });
      payment = { id: paymentId, status: 'PENDING', expiresAt: holdUntil.toISOString() };
      this.transition('PENDING_PAYMENT');
    }

    await this.audit.record(tx, {
      action: 'consultation.book',
      entityType: 'consultation',
      entityId: row.id,
      metadata: { doctorId: slot.doctor_id, slotId: slot.id, free },
    });
    this.bumpSlots(tx, slot.doctor_id);
    return { status: 201, body: { ...this.view(row, 'patient', true), payment } };
  }

  /* ================================================================== PAYMENT OUTCOMES (webhook-driven) */
  async onPaymentSucceeded(paymentId: string, providerRef: string | undefined, eventId: string): Promise<'confirmed' | 'late_refund' | 'noop'> {
    return this.db.tx(async (tx) => {
      if (!(await this.firstDelivery(tx, eventId))) return 'noop';
      const p = await this.lockPayment(tx, paymentId);
      if (!p) return 'noop';
      if (providerRef && !p.provider_ref) await tx.query('UPDATE payments SET provider_ref = $2 WHERE id = $1', [paymentId, providerRef]);
      if (!['PENDING', 'REQUIRES_PAYMENT'].includes(p.status)) {
        if (p.status === 'VOIDED' || p.status === 'FAILED') return this.lateSuccess(tx, p, providerRef);
        return 'noop';
      }
      const c = await this.lockConsultation(tx, p.consultation_id);
      if (!c || c.status !== 'PENDING_PAYMENT') return this.lateSuccess(tx, p, providerRef);

      await tx.query(`UPDATE payments SET status = 'SUCCEEDED', paid_at = $2 WHERE id = $1`, [paymentId, this.clock.now()]);
      await tx.query(`UPDATE consultations SET status = 'CONFIRMED', version = version + 1 WHERE id = $1`, [c.id]);
      await tx.query(`UPDATE availability_slots SET status = 'BOOKED', held_by = NULL, hold_expires_at = NULL, version = version + 1 WHERE id = $1`, [c.slot_id]);
      await this.audit.record(tx, { action: 'payment.succeeded', actorId: null, actorRole: 'system', entityType: 'payment', entityId: paymentId, metadata: { consultationId: c.id } });
      await this.audit.record(tx, { action: 'consultation.confirm', actorId: null, actorRole: 'system', entityType: 'consultation', entityId: c.id });
      await this.notify(tx, c, 'booking.confirmed');
      this.metrics.payments.inc({ event: 'succeeded' });
      this.transition('CONFIRMED');
      return 'confirmed';
    });
  }

  /** Compensation: money arrived but the booking can no longer be honoured → refund. */
  private async lateSuccess(tx: Tx, p: PaymentRow, providerRef?: string): Promise<'late_refund'> {
    await tx.query(
      `UPDATE payments SET status = 'REFUND_PENDING', refund_amount_minor = amount_minor, paid_at = $2, provider_ref = coalesce(provider_ref, $3) WHERE id = $1`,
      [p.id, this.clock.now(), providerRef ?? null],
    );
    await this.queue.enqueue(tx, 'payment.refund', { paymentId: p.id }, { dedupeKey: `refund:${p.id}` });
    await this.audit.record(tx, { action: 'payment.late_success_refund', actorId: null, actorRole: 'system', entityType: 'payment', entityId: p.id, metadata: { consultationId: p.consultation_id } });
    this.metrics.sagaCompensations.inc({ reason: 'late_payment' });
    this.metrics.payments.inc({ event: 'late_refund' });
    return 'late_refund';
  }

  async onPaymentFailed(paymentId: string, failureCode: string | undefined, eventId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      if (!(await this.firstDelivery(tx, eventId))) return;
      const p = await this.lockPayment(tx, paymentId);
      if (!p || !['PENDING', 'REQUIRES_PAYMENT'].includes(p.status)) return;
      const c = await this.lockConsultation(tx, p.consultation_id);
      await tx.query(`UPDATE payments SET status = 'FAILED', failure_code = $2 WHERE id = $1`, [paymentId, failureCode?.slice(0, 64) ?? null]);
      if (c && c.status === 'PENDING_PAYMENT') {
        await this.releaseAndCancel(tx, c, 'PAYMENT_FAILED', null);
        await this.notify(tx, c, 'booking.payment_failed');
      }
      await this.audit.record(tx, { action: 'payment.failed', actorId: null, actorRole: 'system', entityType: 'payment', entityId: paymentId, outcome: 'FAILURE', metadata: { failureCode } });
      this.metrics.payments.inc({ event: 'failed' });
      this.metrics.sagaCompensations.inc({ reason: 'payment_failed' });
    });
  }

  private async firstDelivery(tx: Tx, eventId: string): Promise<boolean> {
    const r = await tx.query(`INSERT INTO webhook_events (provider, event_id) VALUES ('mock', $1) ON CONFLICT DO NOTHING`, [eventId]);
    return r.rowCount === 1;
  }

  /* ================================================================== HOLD EXPIRY (scheduler) */
  async expireHolds(batch = 200): Promise<number> {
    const now = this.clock.now();
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT c.id FROM consultations c JOIN availability_slots s ON s.id = c.slot_id
        WHERE c.status = 'PENDING_PAYMENT' AND s.status = 'HELD' AND s.hold_expires_at < $1 LIMIT $2`,
      [now, batch],
    );
    let expired = 0;
    for (const { id } of rows) {
      const done = await this.db.tx(async (tx) => {
        const c = await this.lockConsultation(tx, id, true);
        if (!c || c.status !== 'PENDING_PAYMENT') return false; // paid (or cancelled) in the meantime → nothing to compensate
        const slot = await tx.query<{ hold_expires_at: Date | null }>('SELECT hold_expires_at FROM availability_slots WHERE id = $1', [c.slot_id]);
        const exp = slot.rows[0]?.hold_expires_at;
        if (!exp || exp >= now) return false;
        await this.releaseAndCancel(tx, c, 'PAYMENT_TIMEOUT', null);
        await this.notify(tx, c, 'booking.expired');
        await this.audit.record(tx, { action: 'consultation.hold_expired', actorId: null, actorRole: 'system', entityType: 'consultation', entityId: c.id });
        this.metrics.sagaCompensations.inc({ reason: 'hold_timeout' });
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  /** Shared compensation: cancel consultation, reopen slot, void any open payment. Caller holds the consultation lock. */
  private async releaseAndCancel(tx: Tx, c: ConsultationRow, reason: string, cancelledBy: string | null): Promise<void> {
    await tx.query(
      `UPDATE consultations SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = $4, version = version + 1 WHERE id = $1`,
      [c.id, reason, cancelledBy, this.clock.now()],
    );
    await tx.query(
      `UPDATE availability_slots SET status = 'OPEN', held_by = NULL, hold_expires_at = NULL, version = version + 1
        WHERE id = $1 AND status IN ('HELD','BOOKED')`,
      [c.slot_id],
    );
    const v = await tx.query<{ id: string }>(
      `UPDATE payments SET status = 'VOIDED' WHERE consultation_id = $1 AND status IN ('PENDING','REQUIRES_PAYMENT') RETURNING id`,
      [c.id],
    );
    for (const p of v.rows) {
      await this.queue.enqueue(tx, 'payment.void', { paymentId: p.id }, { dedupeKey: `void:${p.id}` });
    }
    this.bumpSlots(tx, c.doctor_id);
    this.transition('CANCELLED');
  }

  /* ================================================================== CANCEL */
  async cancel(actor: Actor, consultationId: string, reason: string | undefined): Promise<ConsultationView> {
    const result = await this.db.tx(async (tx) => {
      const c = await this.lockConsultation(tx, consultationId);
      if (!c) throw notFound('Consultation');
      const party = await this.partyOf(actor, c);
      if (!party && actor.role !== 'admin') throw notFound('Consultation'); // do not reveal existence
      if (c.status === 'CANCELLED') return { c, party }; // idempotent
      if (!['PENDING_PAYMENT', 'CONFIRMED'].includes(c.status)) {
        throw conflict('CANNOT_CANCEL', `A consultation that is ${c.status} cannot be cancelled`);
      }
      const now = this.clock.now();
      const hoursUntil = (c.scheduled_at.getTime() - now.getTime()) / 3_600_000;
      const patientLate = party === 'patient' && hoursUntil < this.cfg.booking.fullRefundHours;

      const pay = await tx.query<PaymentRow>('SELECT * FROM payments WHERE consultation_id = $1 AND status NOT IN (\'FAILED\',\'VOIDED\') FOR UPDATE', [c.id]);
      const payment = pay.rows[0];
      await tx.query(
        `UPDATE consultations SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = $4, version = version + 1 WHERE id = $1`,
        [c.id, reason ?? null, actor.id, now],
      );
      // Slot: patient/system cancellation reopens it for others; a doctor/admin cancellation closes it.
      const reopen = party === 'patient' && c.scheduled_at > addMinutes(now, this.cfg.booking.minLeadMinutes);
      await tx.query(
        `UPDATE availability_slots SET status = $2, held_by = NULL, hold_expires_at = NULL, version = version + 1 WHERE id = $1 AND status IN ('HELD','BOOKED')`,
        [c.slot_id, reopen ? 'OPEN' : 'CANCELLED'],
      );
      let refund = 0;
      if (payment) {
        if (payment.status === 'SUCCEEDED') {
          refund = patientLate ? 0 : payment.amount_minor;
          if (refund > 0) {
            await tx.query(`UPDATE payments SET status = 'REFUND_PENDING', refund_amount_minor = $2 WHERE id = $1`, [payment.id, refund]);
            await this.queue.enqueue(tx, 'payment.refund', { paymentId: payment.id }, { dedupeKey: `refund:${payment.id}` });
            this.metrics.sagaCompensations.inc({ reason: 'cancel_refund' });
          }
        } else if (['PENDING', 'REQUIRES_PAYMENT'].includes(payment.status)) {
          await tx.query(`UPDATE payments SET status = 'VOIDED' WHERE id = $1`, [payment.id]);
          await this.queue.enqueue(tx, 'payment.void', { paymentId: payment.id }, { dedupeKey: `void:${payment.id}` });
          this.metrics.sagaCompensations.inc({ reason: 'cancel_void' });
        }
      }
      await this.audit.record(tx, {
        action: 'consultation.cancel',
        entityType: 'consultation',
        entityId: c.id,
        metadata: { by: party ?? 'admin', refundMinor: refund, reopenedSlot: reopen },
      });
      const other = party === 'doctor' || party === undefined ? c.patient_id : await this.doctorUserId(tx, c.doctor_id);
      if (other) await this.queue.enqueue(tx, 'notify', { userId: other, template: 'consultation.cancelled', data: { consultationId: c.id } });
      this.bumpSlots(tx, c.doctor_id);
      this.transition('CANCELLED');
      const updated = (await tx.query<ConsultationRow>('SELECT * FROM consultations WHERE id = $1', [c.id])).rows[0] as ConsultationRow;
      return { c: updated, party };
    });
    return this.view(result.c, result.party ?? 'patient', false);
  }

  /* ================================================================== helpers */
  async partyOf(actor: Actor, c: Pick<ConsultationRow, 'patient_id' | 'doctor_id'>): Promise<Party | undefined> {
    if (actor.role === 'patient' && c.patient_id === actor.id) return 'patient';
    if (actor.role === 'doctor') {
      const doctorId = await this.doctors.doctorIdForUser(actor.id).catch(() => undefined);
      if (doctorId && doctorId === c.doctor_id) return 'doctor';
    }
    return undefined;
  }

  private async doctorUserId(tx: Tx, doctorId: string): Promise<string | undefined> {
    return (await tx.query<{ user_id: string }>('SELECT user_id FROM doctors WHERE id = $1', [doctorId])).rows[0]?.user_id;
  }

  async lockConsultation(tx: Tx, id: string, skipLocked = false): Promise<ConsultationRow | undefined> {
    const r = await tx.query<ConsultationRow>(`SELECT * FROM consultations WHERE id = $1 FOR UPDATE${skipLocked ? ' SKIP LOCKED' : ''}`, [id]);
    return r.rows[0];
  }

  private async lockPayment(tx: Tx, id: string): Promise<PaymentRow | undefined> {
    return (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
  }

  async notify(tx: Tx, c: Pick<ConsultationRow, 'id' | 'patient_id' | 'doctor_id'>, template: string): Promise<void> {
    await this.queue.enqueue(tx, 'notify', { userId: c.patient_id, template, data: { consultationId: c.id } });
    if (template === 'booking.confirmed') {
      const du = await this.doctorUserId(tx, c.doctor_id);
      if (du) await this.queue.enqueue(tx, 'notify', { userId: du, template: 'booking.new', data: { consultationId: c.id } });
    }
  }

  view(r: ConsultationRow, party: Party, includeReason: boolean, includeNotes = false): ConsultationView {
    const v: ConsultationView = {
      id: r.id,
      status: r.status,
      doctorId: r.doctor_id,
      patientId: r.patient_id,
      specialty: r.specialty,
      scheduledAt: r.scheduled_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      fee: { amountMinor: r.fee_minor, currency: r.currency.trim() },
      startedAt: r.started_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    };
    if (includeReason && r.reason_enc) v.reason = this.crypto.decrypt(r.reason_enc, AAD.consultationReason(r.id));
    if (includeNotes && party === 'doctor' && r.notes_enc) v.notes = this.crypto.decrypt(r.notes_enc, AAD.consultationNotes(r.id));
    if (r.status === 'CANCELLED' && r.cancelled_at) {
      v.cancellation = { reason: r.cancel_reason, at: r.cancelled_at.toISOString(), by: r.cancelled_by };
    }
    return v;
  }

  /* ================================================================== READS */
  async get(actor: Actor, id: string): Promise<ConsultationView> {
    const { rows } = await this.db.query<ConsultationRow>('SELECT * FROM consultations WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw notFound('Consultation');
    const party = await this.partyOf(actor, c);
    if (!party) throw notFound('Consultation');
    // PHI read → audit trail
    await this.audit.recordStandalone({ action: 'consultation.read', entityType: 'consultation', entityId: id, metadata: { as: party } });
    const view = this.view(c, party, true, true);
    if (party === 'patient') {
      const p = await this.db.query<{ id: string; status: string; expires_at: Date | null }>(
        `SELECT id, status, expires_at FROM payments WHERE consultation_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      const pr = p.rows[0];
      view.payment = pr ? { id: pr.id, status: pr.status, expiresAt: pr.expires_at?.toISOString() ?? null } : null;
    }
    return view;
  }

  async list(actor: Actor, q: z.infer<typeof listConsultationsSchema>) {
    const cursor = decodeCursor(q.cursor, z.strictObject({ at: z.string().datetime(), id: uuid }));
    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where: string[] = [];
    let party: Party;
    if (actor.role === 'patient') {
      party = 'patient';
      where.push(`patient_id = ${p(actor.id)}`);
    } else {
      party = 'doctor';
      where.push(`doctor_id = ${p(await this.doctors.doctorIdForUser(actor.id))}`);
    }
    if (q.status) where.push(`status = ${p(q.status)}`);
    if (q.from) where.push(`scheduled_at >= ${p(new Date(q.from))}`);
    if (q.to) where.push(`scheduled_at < ${p(new Date(q.to))}`);
    if (cursor) where.push(`(scheduled_at, id) < (${p(cursor.at)}::timestamptz, ${p(cursor.id)}::uuid)`);
    const { rows } = await this.db.read<ConsultationRow>(
      `SELECT * FROM consultations WHERE ${where.join(' AND ')} ORDER BY scheduled_at DESC, id DESC LIMIT ${p(q.limit + 1)}`,
      params,
    );
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.view(r, party, false)), // list view never includes clinical free text
      nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.scheduled_at.toISOString(), id: last.id }) : undefined,
    };
  }
}

export interface PaymentRow {
  id: string;
  consultation_id: string;
  patient_id: string;
  amount_minor: number;
  currency: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  client_secret_enc: string | null;
  refund_amount_minor: number | null;
  refund_ref: string | null;
  expires_at: Date | null;
}

export { forbidden };
