import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { addDays, addMinutes, type Clock } from '../../shared/clock';
import type { Cache } from '../../shared/cache';
import type { Db } from '../../shared/db';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { cursorSchema, decodeCursor, encodeCursor, isoDateTime, limitSchema, shortText, uuid } from '../../shared/validation';
import type { AuditService } from '../audit/service';

/* ------------------------------------------------------------------------------------------------ schemas */
export const doctorUpdateSchema = z.strictObject({
  displayName: shortText(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  specialties: z.array(shortText(60)).min(1).max(8).optional(),
  languages: z.array(shortText(40)).max(10).optional(),
  city: shortText(80).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  consultationFeeMinor: z.number().int().min(0).max(10_000_000).optional(),
});

export const availabilitySchema = z.strictObject({
  windows: z
    .array(z.strictObject({ start: isoDateTime, end: isoDateTime }))
    .min(1)
    .max(100),
  slotMinutes: z.union([z.literal(10), z.literal(15), z.literal(20), z.literal(30), z.literal(45), z.literal(60)]),
});

export const searchSchema = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  specialty: shortText(60).optional(),
  language: shortText(40).optional(),
  city: shortText(80).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  minFeeMinor: z.coerce.number().int().min(0).optional(),
  maxFeeMinor: z.coerce.number().int().min(0).optional(),
  minExperience: z.coerce.number().int().min(0).max(70).optional(),
  availableFrom: isoDateTime.optional(),
  availableTo: isoDateTime.optional(),
  sort: z.enum(['relevance', 'rating', 'fee_asc', 'fee_desc', 'experience']).optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});
export type SearchInput = z.infer<typeof searchSchema>;

export const slotsQuerySchema = z.strictObject({ from: isoDateTime.optional(), to: isoDateTime.optional() });

const searchCursorSchema = z.strictObject({ v: z.number().nullable(), id: uuid });

export const verificationSchema = z.strictObject({
  decision: z.enum(['VERIFIED', 'REJECTED', 'SUSPENDED']),
  note: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------------------------------------ types */
export interface PublicDoctor {
  id: string;
  displayName: string;
  bio: string | null;
  specialties: string[];
  languages: string[];
  city: string | null;
  yearsExperience: number;
  consultationFee: { amountMinor: number; currency: string };
  rating: { average: number; count: number };
  nextAvailableAt?: string | null;
}

interface DoctorRow {
  id: string;
  user_id: string;
  display_name: string;
  bio: string | null;
  specialties: string[];
  languages: string[];
  city: string | null;
  years_experience: number;
  consultation_fee_minor: number;
  currency: string;
  rating_avg: number;
  rating_count: number;
  verification_status: string;
  license_number: string;
}

const toPublic = (r: DoctorRow): PublicDoctor => ({
  id: r.id,
  displayName: r.display_name,
  bio: r.bio,
  specialties: r.specialties,
  languages: r.languages,
  city: r.city,
  yearsExperience: r.years_experience,
  consultationFee: { amountMinor: r.consultation_fee_minor, currency: r.currency.trim() },
  rating: { average: r.rating_avg, count: r.rating_count },
});

const TTL = { doctor: 60, search: 30, slots: 10, doctorId: 300 } as const;

export class DoctorService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly cfg: Config,
  ) {}

  /* -------------------------------------------------------------------- identity helpers */
  async doctorIdForUser(userId: string): Promise<string> {
    const id = await this.cache.wrap<string | null>(`doctorId:${userId}`, TTL.doctorId, async () => {
      const { rows } = await this.db.query<{ id: string }>('SELECT id FROM doctors WHERE user_id = $1', [userId]);
      return rows[0]?.id ?? null;
    });
    if (!id) throw forbidden('No doctor profile is associated with this account', 'NOT_A_DOCTOR');
    return id;
  }

  private async assertVerified(doctorId: string): Promise<void> {
    const { rows } = await this.db.query<{ verification_status: string }>('SELECT verification_status FROM doctors WHERE id = $1', [doctorId]);
    if (rows[0]?.verification_status !== 'VERIFIED') {
      throw forbidden('Your profile must be verified by an administrator before you can publish availability', 'DOCTOR_NOT_VERIFIED');
    }
  }

  async invalidateDoctor(doctorId: string): Promise<void> {
    await Promise.all([this.cache.del(`doctor:${doctorId}`), this.cache.incr('search:ver')]);
  }

  /* -------------------------------------------------------------------- reads */
  async getPublic(id: string): Promise<PublicDoctor> {
    const doc = await this.cache.wrap<PublicDoctor | null>(`doctor:${id}`, TTL.doctor, async () => {
      const { rows } = await this.db.read<DoctorRow>(
        `SELECT * FROM doctors WHERE id = $1 AND verification_status = 'VERIFIED'`,
        [id],
      );
      return rows[0] ? toPublic(rows[0]) : null;
    });
    if (!doc) throw notFound('Doctor');
    return doc;
  }

  async getSelf(userId: string) {
    const { rows } = await this.db.query<DoctorRow>('SELECT * FROM doctors WHERE user_id = $1', [userId]);
    const r = rows[0];
    if (!r) throw forbidden('No doctor profile is associated with this account', 'NOT_A_DOCTOR');
    return { ...toPublic(r), licenseNumber: r.license_number, verificationStatus: r.verification_status };
  }

  async updateSelf(userId: string, input: z.infer<typeof doctorUpdateSchema>) {
    const doctorId = await this.doctorIdForUser(userId);
    const sets: string[] = [];
    const params: unknown[] = [doctorId];
    const map: Record<string, string> = {
      displayName: 'display_name',
      bio: 'bio',
      specialties: 'specialties',
      languages: 'languages',
      city: 'city',
      yearsExperience: 'years_experience',
      consultationFeeMinor: 'consultation_fee_minor',
    };
    for (const [k, v] of Object.entries(input)) {
      if (v === undefined) continue;
      params.push(v);
      sets.push(`${map[k]} = $${params.length}`);
    }
    if (!sets.length) throw badRequest('NO_CHANGES', 'No updatable fields supplied');
    await this.db.tx(async (tx) => {
      await tx.query(`UPDATE doctors SET ${sets.join(', ')} WHERE id = $1`, params);
      await this.audit.record(tx, { action: 'doctor.profile_update', entityType: 'doctor', entityId: doctorId, metadata: { fields: Object.keys(input) } });
      tx.afterCommit(() => this.invalidateDoctor(doctorId));
    });
    return this.getSelf(userId);
  }

  /* -------------------------------------------------------------------- search */
  async search(input: SearchInput): Promise<{ items: PublicDoctor[]; nextCursor?: string }> {
    const norm = { ...input, q: input.q?.toLowerCase(), specialty: input.specialty?.toLowerCase(), city: input.city?.toLowerCase(), language: input.language?.toLowerCase() };
    const ver = await this.cache.getNumber('search:ver');
    const key = `search:${ver}:${createHash('sha1').update(JSON.stringify(norm)).digest('base64url')}`;
    return this.cache.wrap(key, TTL.search, () => this.runSearch(norm));
  }

  private async runSearch(input: SearchInput): Promise<{ items: PublicDoctor[]; nextCursor?: string }> {
    if ((input.availableFrom === undefined) !== (input.availableTo === undefined)) {
      throw badRequest('INVALID_AVAILABILITY_FILTER', 'availableFrom and availableTo must be provided together');
    }
    const sort = input.sort ?? (input.q ? 'relevance' : 'rating');
    if (sort === 'relevance' && !input.q) throw badRequest('INVALID_SORT', 'sort=relevance requires q');
    const cursor = decodeCursor(input.cursor, searchCursorSchema);

    const params: unknown[] = [];
    const p = (v: unknown) => (params.push(v), `$${params.length}`);
    const where: string[] = [`d.verification_status = 'VERIFIED'`];
    let scoreExpr = 'NULL::float8';

    if (input.specialty) where.push(`d.specialties @> ARRAY[${p(input.specialty)}]::text[]`);
    if (input.language) where.push(`d.languages @> ARRAY[${p(input.language)}]::text[]`);
    if (input.city) where.push(`lower(d.city) = ${p(input.city)}`);
    if (input.minRating !== undefined) where.push(`d.rating_avg >= ${p(input.minRating)}`);
    if (input.minFeeMinor !== undefined) where.push(`d.consultation_fee_minor >= ${p(input.minFeeMinor)}`);
    if (input.maxFeeMinor !== undefined) where.push(`d.consultation_fee_minor <= ${p(input.maxFeeMinor)}`);
    if (input.minExperience !== undefined) where.push(`d.years_experience >= ${p(input.minExperience)}`);
    if (input.availableFrom && input.availableTo) {
      const from = new Date(input.availableFrom);
      const to = new Date(input.availableTo);
      if (!(to > from) || to.getTime() - from.getTime() > 31 * 86_400_000) {
        throw badRequest('INVALID_AVAILABILITY_WINDOW', 'availableTo must be after availableFrom and within 31 days');
      }
      where.push(
        `EXISTS (SELECT 1 FROM availability_slots s WHERE s.doctor_id = d.id AND s.status = 'OPEN' AND s.start_at >= ${p(from)} AND s.start_at < ${p(to)})`,
      );
    }
    if (input.q) {
      // Prefix full-text over name/specialty/bio plus trigram similarity for typos. Tokens are stripped to letters/digits
      // and passed as a bind parameter: user text never reaches tsquery syntax or SQL text.
      const tokens = (input.q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 6);
      if (tokens.length === 0) throw badRequest('INVALID_QUERY', 'q must contain letters or digits');
      const tsq = p(tokens.map((t) => `${t}:*`).join(' & '));
      const raw = p(input.q);
      where.push(`(d.search_tsv @@ to_tsquery('simple', ${tsq}) OR d.display_name % ${raw})`);
      scoreExpr = `(ts_rank(d.search_tsv, to_tsquery('simple', ${tsq})) * 2 + similarity(d.display_name, ${raw}))::float8`;
    }

    // Keyset pagination: (sortValue, id) with explicit per-sort comparison (mixed DESC/ASC directions).
    const sortCol: Record<string, { expr: string; dir: 'ASC' | 'DESC' }> = {
      relevance: { expr: 'score', dir: 'DESC' },
      rating: { expr: 'd.rating_avg', dir: 'DESC' },
      fee_asc: { expr: 'd.consultation_fee_minor', dir: 'ASC' },
      fee_desc: { expr: 'd.consultation_fee_minor', dir: 'DESC' },
      experience: { expr: 'd.years_experience', dir: 'DESC' },
    };
    const sc = sortCol[sort] as { expr: string; dir: 'ASC' | 'DESC' };
    const outer: string[] = [];
    if (cursor) {
      if (cursor.v === null) throw badRequest('INVALID_CURSOR', 'Pagination cursor is invalid');
      const v = p(cursor.v);
      const id = p(cursor.id);
      const cmp = sc.dir === 'DESC' ? '<' : '>';
      outer.push(`(sv ${cmp} ${v} OR (sv = ${v} AND id > ${id}::uuid))`);
    }
    const limit = input.limit;
    const sql = `
      WITH matched AS (
        SELECT d.*, ${sc.expr === 'score' ? 'score' : sc.expr} AS sv
          FROM (SELECT d.*, ${scoreExpr} AS score FROM doctors d WHERE ${where.join(' AND ')}) d
      )
      SELECT * FROM matched ${outer.length ? 'WHERE ' + outer.join(' AND ') : ''}
       ORDER BY sv ${sc.dir}, id ASC LIMIT ${p(limit + 1)}`;
    const { rows } = await this.db.read<DoctorRow & { sv: number }>(sql, params);

    const page = rows.slice(0, limit);
    const next = await this.nextAvailability(page.map((r) => r.id));
    const items = page.map((r) => ({ ...toPublic(r), nextAvailableAt: next.get(r.id) ?? null }));
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeCursor({ v: last.sv, id: last.id }) : undefined };
  }

  private async nextAvailability(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const earliest = addMinutes(this.clock.now(), this.cfg.booking.minLeadMinutes);
    const { rows } = await this.db.read<{ doctor_id: string; next: Date }>(
      `SELECT doctor_id, min(start_at) AS next FROM availability_slots
        WHERE doctor_id = ANY($1::uuid[]) AND status = 'OPEN' AND start_at > $2 GROUP BY doctor_id`,
      [ids, earliest],
    );
    return new Map(rows.map((r) => [r.doctor_id, r.next.toISOString()]));
  }

  /* -------------------------------------------------------------------- slots */
  async listOpenSlots(doctorId: string, q: z.infer<typeof slotsQuerySchema>) {
    const now = this.clock.now();
    const earliest = addMinutes(now, this.cfg.booking.minLeadMinutes);
    const from = new Date(Math.max((q.from ? new Date(q.from) : earliest).getTime(), earliest.getTime()));
    from.setSeconds(0, 0);
    const to = q.to ? new Date(q.to) : addDays(from, 7);
    if (!(to > from) || to.getTime() - from.getTime() > 14 * 86_400_000) {
      throw badRequest('INVALID_RANGE', 'to must be after from and within 14 days');
    }
    await this.getPublic(doctorId); // 404 for unknown/unverified doctors (cached)
    const ver = await this.cache.getNumber(`slots:ver:${doctorId}`);
    const key = `slots:${doctorId}:${ver}:${from.toISOString()}:${to.toISOString()}`;
    const slots = await this.cache.wrap(key, TTL.slots, async () => {
      const { rows } = await this.db.read<{ id: string; start_at: Date; end_at: Date }>(
        `SELECT id, start_at, end_at FROM availability_slots
          WHERE doctor_id = $1 AND status = 'OPEN' AND start_at >= $2 AND start_at < $3 ORDER BY start_at LIMIT 500`,
        [doctorId, from, to],
      );
      return rows.map((r) => ({ id: r.id, startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString() }));
    });
    return { doctorId, slots };
  }

  /* -------------------------------------------------------------------- availability (doctor) */
  async createAvailability(userId: string, input: z.infer<typeof availabilitySchema>) {
    const doctorId = await this.doctorIdForUser(userId);
    await this.assertVerified(doctorId);
    const now = this.clock.now();
    const horizon = addDays(now, this.cfg.booking.horizonDays);
    const windows = input.windows
      .map((w) => ({ start: new Date(w.start), end: new Date(w.end) }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
    const slotMs = input.slotMinutes * 60_000;
    const starts: Date[] = [];
    const ends: Date[] = [];
    windows.forEach((w, i) => {
      if (!(w.end > w.start)) throw unprocessable('INVALID_WINDOW', `windows[${i}]: end must be after start`);
      if (w.start < addMinutes(now, this.cfg.booking.minLeadMinutes)) throw unprocessable('WINDOW_IN_PAST', `windows[${i}]: must start in the future`);
      if (w.end > horizon) throw unprocessable('WINDOW_TOO_FAR', `windows[${i}]: beyond the ${this.cfg.booking.horizonDays}-day booking horizon`);
      if (w.end.getTime() - w.start.getTime() > 12 * 3_600_000) throw unprocessable('WINDOW_TOO_LONG', `windows[${i}]: longer than 12 hours`);
      const prev = windows[i - 1];
      if (prev && w.start < prev.end) throw unprocessable('WINDOWS_OVERLAP', `windows[${i}] overlaps the previous window`);
      for (let t = w.start.getTime(); t + slotMs <= w.end.getTime(); t += slotMs) {
        starts.push(new Date(t));
        ends.push(new Date(t + slotMs));
      }
    });
    if (starts.length === 0) throw unprocessable('NO_SLOTS', 'The windows are shorter than one slot');
    if (starts.length > 1000) throw unprocessable('TOO_MANY_SLOTS', 'At most 1000 slots can be created per request');

    const created = await this.db.tx(async (tx) => {
      // ON CONFLICT DO NOTHING also swallows exclusion-constraint overlaps, making the call idempotent/re-runnable.
      const r = await tx.query<{ id: string }>(
        `INSERT INTO availability_slots (doctor_id, start_at, end_at)
         SELECT $1, s, e FROM unnest($2::timestamptz[], $3::timestamptz[]) AS t(s, e)
         ON CONFLICT DO NOTHING RETURNING id`,
        [doctorId, starts, ends],
      );
      await this.audit.record(tx, {
        action: 'availability.create',
        entityType: 'doctor',
        entityId: doctorId,
        metadata: { requested: starts.length, created: r.rowCount, slotMinutes: input.slotMinutes },
      });
      tx.afterCommit(() => this.cache.incr(`slots:ver:${doctorId}`).then(() => undefined));
      return r.rowCount ?? 0;
    });
    return { requested: starts.length, created, skippedOverlapping: starts.length - created };
  }

  async listOwnSlots(userId: string, from: Date, to: Date) {
    const doctorId = await this.doctorIdForUser(userId);
    if (!(to > from) || to.getTime() - from.getTime() > 31 * 86_400_000) throw badRequest('INVALID_RANGE', 'to must be after from and within 31 days');
    const { rows } = await this.db.query<{ id: string; start_at: Date; end_at: Date; status: string }>(
      `SELECT id, start_at, end_at, status FROM availability_slots
        WHERE doctor_id = $1 AND start_at >= $2 AND start_at < $3 AND status <> 'CANCELLED' ORDER BY start_at LIMIT 1000`,
      [doctorId, from, to],
    );
    return { slots: rows.map((r) => ({ id: r.id, startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString(), status: r.status })) };
  }

  async cancelOwnSlot(userId: string, slotId: string): Promise<void> {
    const doctorId = await this.doctorIdForUser(userId);
    await this.db.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE availability_slots SET status = 'CANCELLED', version = version + 1 WHERE id = $1 AND doctor_id = $2 AND status = 'OPEN'`,
        [slotId, doctorId],
      );
      if (r.rowCount === 0) {
        const s = await tx.query<{ status: string }>('SELECT status FROM availability_slots WHERE id = $1 AND doctor_id = $2', [slotId, doctorId]);
        if (!s.rows[0]) throw notFound('Slot');
        throw conflict('SLOT_NOT_OPEN', `Slot is ${s.rows[0].status}; cancel the consultation instead`);
      }
      await this.audit.record(tx, { action: 'availability.cancel', entityType: 'slot', entityId: slotId });
      tx.afterCommit(() => this.cache.incr(`slots:ver:${doctorId}`).then(() => undefined));
    });
  }

  /* -------------------------------------------------------------------- admin */
  async adminList(status: string | undefined, limit: number, cursor?: string) {
    const c = decodeCursor(cursor, z.strictObject({ at: z.string().datetime(), id: uuid }));
    const params: unknown[] = [];
    const where: string[] = [];
    if (status) {
      params.push(status);
      where.push(`d.verification_status = $${params.length}`);
    }
    if (c) {
      params.push(c.at, c.id);
      where.push(`(d.created_at, d.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await this.db.query<DoctorRow & { created_at: Date }>(
      `SELECT d.* FROM doctors d ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.created_at, d.id LIMIT $${params.length}`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ ...toPublic(r), licenseNumber: r.license_number, verificationStatus: r.verification_status, createdAt: r.created_at.toISOString() })),
      nextCursor: rows.length > limit && last ? encodeCursor({ at: last.created_at.toISOString(), id: last.id }) : undefined,
    };
  }

  async adminVerify(adminUserId: string, doctorId: string, input: z.infer<typeof verificationSchema>) {
    await this.db.tx(async (tx) => {
      const r = await tx.query<{ verification_status: string }>(
        `UPDATE doctors SET verification_status = $2, verified_by = $3, verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE verified_at END
          WHERE id = $1 RETURNING (SELECT verification_status FROM doctors WHERE id = $1) AS verification_status`,
        [doctorId, input.decision, adminUserId],
      );
      if (r.rowCount === 0) throw notFound('Doctor');
      if (input.decision !== 'VERIFIED') {
        await tx.query(`UPDATE availability_slots SET status = 'CANCELLED', version = version + 1 WHERE doctor_id = $1 AND status = 'OPEN'`, [doctorId]);
      }
      await this.audit.record(tx, {
        action: 'admin.doctor_verification',
        entityType: 'doctor',
        entityId: doctorId,
        metadata: { from: r.rows[0]?.verification_status, to: input.decision, note: input.note },
      });
      tx.afterCommit(async () => {
        await this.invalidateDoctor(doctorId);
        await this.cache.incr(`slots:ver:${doctorId}`);
      });
    });
    return { id: doctorId, verificationStatus: input.decision };
  }
}
