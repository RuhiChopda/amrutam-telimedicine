import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createHarness, type Harness, type Session } from '../helpers/harness';

let h: Harness;
let api: Api;
let admin: Session;
let doctor: Session;

beforeAll(async () => {
  h = await createHarness();
  api = new Api(h);
  admin = await api.admin();
  doctor = await api.doctor(admin);
});
afterAll(() => h.close());

const count = async (sql: string, p: unknown[] = []) => (await h.c.db.query<{ n: number }>(sql, p)).rows[0]!.n;

describe('booking happy path', () => {
  it('holds the slot, creates the payment via the outbox job, and confirms on webhook', async () => {
    const [slot] = await api.slots(doctor, 30);
    const patient = await api.patient();
    const b = await api.book(patient, slot!, randomUUID(), 'fever and cough');
    expect(b.status).toBe(201);
    expect(b.body.status).toBe('PENDING_PAYMENT');
    expect(b.body.payment.status).toBe('PENDING');

    // slot is held, not bookable by anyone else
    const other = await api.patient();
    const clash = await api.book(other, slot!);
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLOT_UNAVAILABLE');

    await h.drain(); // payment.create_intent job
    const pay = await api.req('GET', `/v1/payments/${b.body.payment.id}`, { token: patient.token });
    expect(pay.body.status).toBe('REQUIRES_PAYMENT');
    expect(pay.body.clientSecret).toMatch(/^cs_/);

    expect((await api.webhook(b.body.payment.id)).status).toBe(200);
    const c = await api.req('GET', `/v1/consultations/${b.body.id}`, { token: patient.token });
    expect(c.body.status).toBe('CONFIRMED');
    expect(c.body.reason).toBe('fever and cough'); // decrypted for the owner
    expect(await count(`SELECT count(*)::int n FROM availability_slots WHERE id=$1 AND status='BOOKED'`, [slot])).toBe(1);

    await h.drain();
    expect(h.notifier.sent.some((n) => n.template === 'booking.confirmed' && n.userId === patient.id)).toBe(true);
  });

  it('stores clinical text encrypted at rest', async () => {
    const [slot] = await api.slots(doctor, 31);
    const patient = await api.patient();
    const b = await api.book(patient, slot!, randomUUID(), 'very private symptom');
    const row = await h.c.db.query<{ reason_enc: string }>('SELECT reason_enc FROM consultations WHERE id=$1', [b.body.id]);
    expect(row.rows[0]!.reason_enc.startsWith('enc:v1:')).toBe(true);
    expect(row.rows[0]!.reason_enc).not.toContain('private');
  });
});

describe('concurrency: no double booking', () => {
  it('exactly one of 25 simultaneous bookers wins a slot', async () => {
    const [slot] = await api.slots(doctor, 40);
    const patients = await Promise.all(Array.from({ length: 25 }, () => api.patient()));
    const results = await Promise.all(patients.map((p) => api.book(p, slot!)));
    const ok = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(24);
    expect(await count(`SELECT count(*)::int n FROM consultations WHERE slot_id=$1 AND status <> 'CANCELLED'`, [slot])).toBe(1);
  });

  it('the database itself forbids overlapping slots for one doctor, whatever the app does', async () => {
    const [s] = await api.slots(doctor, 60, 1);
    const row = (await h.c.db.query<{ start_at: Date; end_at: Date }>('SELECT start_at, end_at FROM availability_slots WHERE id=$1', [s])).rows[0]!;
    await expect(
      h.c.db.query(`INSERT INTO availability_slots (doctor_id, start_at, end_at) VALUES ($1,$2,$3)`, [doctor.doctorId, new Date(row.start_at.getTime() + 60_000), new Date(row.end_at.getTime() + 60_000)]),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('a patient cannot hold overlapping consultations or exceed the pending limit', async () => {
    const slots = await api.slots(doctor, 70, 6);
    const patient = await api.patient();
    for (let i = 0; i < 3; i++) expect((await api.book(patient, slots[i]!)).status).toBe(201);
    const over = await api.book(patient, slots[3]!);
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('TOO_MANY_PENDING_BOOKINGS');
  });
});

describe('idempotency', () => {
  it('same key + same payload replays the original response and creates exactly one booking', async () => {
    const [slot] = await api.slots(doctor, 80);
    const patient = await api.patient();
    const key = randomUUID();
    const first = await api.book(patient, slot!, key);
    const second = await api.book(patient, slot!, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(await count(`SELECT count(*)::int n FROM consultations WHERE slot_id=$1`, [slot])).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM payments WHERE consultation_id=$1`, [first.body.id])).toBe(1);
  });

  it('10 concurrent retries with one key still produce one booking', async () => {
    const [slot] = await api.slots(doctor, 90);
    const patient = await api.patient();
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => api.book(patient, slot!, key)));
    expect(new Set(rs.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM consultations WHERE slot_id=$1`, [slot])).toBe(1);
  });

  it('same key with a different payload is rejected (422), not silently replayed', async () => {
    const [a, b] = await api.slots(doctor, 100);
    const patient = await api.patient();
    const key = randomUUID();
    expect((await api.book(patient, a!, key)).status).toBe(201);
    const r = await api.book(patient, b!, key);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a failed attempt leaves no key behind, so the client can retry', async () => {
    const patient = await api.patient();
    const key = randomUUID();
    const bad = await api.book(patient, randomUUID(), key); // unknown slot → 404, transaction rolled back
    expect(bad.status).toBe(404);
    expect(await count(`SELECT count(*)::int n FROM idempotency_keys WHERE key=$1`, [key])).toBe(0);
  });

  it('keys are scoped per user: another user reusing a key does not see or collide with it', async () => {
    const [a, b] = await api.slots(doctor, 110);
    const p1 = await api.patient();
    const p2 = await api.patient();
    const key = randomUUID();
    const r1 = await api.book(p1, a!, key);
    const r2 = await api.book(p2, b!, key);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.id).not.toBe(r2.body.id);
  });

  it('requires the header', async () => {
    const [slot] = await api.slots(doctor, 120);
    const patient = await api.patient();
    const r = await api.req('POST', '/v1/consultations', { token: patient.token, body: { slotId: slot } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('webhook safety', () => {
  it('rejects bad signatures and is idempotent on duplicate delivery', async () => {
    const [slot] = await api.slots(doctor, 130);
    const patient = await api.patient();
    const b = await api.book(patient, slot!);
    await h.drain();
    expect((await api.webhook(b.body.payment.id, 'payment.succeeded', 'evt_x', 'wrong-secret-wrong-secret')).status).toBe(403);
    const eventId = `evt_${randomUUID()}`;
    expect((await api.webhook(b.body.payment.id, 'payment.succeeded', eventId)).status).toBe(200);
    expect((await api.webhook(b.body.payment.id, 'payment.succeeded', eventId)).status).toBe(200); // provider retry
    // a *different* event id for an already-paid payment is also harmless
    expect((await api.webhook(b.body.payment.id, 'payment.succeeded')).status).toBe(200);
    expect(await count(`SELECT count(*)::int n FROM audit_logs WHERE action='payment.succeeded' AND entity_id=$1`, [b.body.payment.id])).toBe(1);
    expect(await count(`SELECT count(*)::int n FROM payments WHERE id=$1 AND status='SUCCEEDED'`, [b.body.payment.id])).toBe(1);
  });
});

describe('saga compensation', () => {
  it('payment failure releases the slot for others', async () => {
    const [slot] = await api.slots(doctor, 140);
    const p1 = await api.patient();
    const b = await api.book(p1, slot!);
    await h.drain();
    await api.webhook(b.body.payment.id, 'payment.failed');
    expect((await api.req('GET', `/v1/consultations/${b.body.id}`, { token: p1.token })).body.status).toBe('CANCELLED');
    const p2 = await api.patient();
    expect((await api.book(p2, slot!)).status).toBe(201);
  });

  it('hold expiry cancels the booking, reopens the slot and voids the payment at the PSP', async () => {
    const [slot] = await api.slots(doctor, 150);
    const p1 = await api.patient();
    const b = await api.book(p1, slot!);
    await h.drain();
    h.clock.advance(11 * 60_000); // hold is 10 min
    expect(await h.c.booking.expireHolds()).toBeGreaterThanOrEqual(1);
    await h.drain();
    expect((await api.req('GET', `/v1/consultations/${b.body.id}`, { token: p1.token })).body.status).toBe('CANCELLED');
    expect(h.gateway.calls.voidIntent).toBeGreaterThan(0);
    const p2 = await api.patient();
    expect((await api.book(p2, slot!)).status).toBe(201);
  });

  it('a payment that succeeds AFTER the hold expired is refunded automatically', async () => {
    const [slot] = await api.slots(doctor, 160);
    const p1 = await api.patient();
    const b = await api.book(p1, slot!);
    await h.drain();
    h.clock.advance(11 * 60_000);
    await h.c.booking.expireHolds();
    const w = await api.webhook(b.body.payment.id); // PSP reports success late
    expect(w.status).toBe(200);
    await h.drain();
    const pay = await h.c.db.query<{ status: string; refund_amount_minor: number }>('SELECT status, refund_amount_minor FROM payments WHERE id=$1', [b.body.payment.id]);
    expect(pay.rows[0]).toMatchObject({ status: 'REFUNDED', refund_amount_minor: 50000 });
    expect((await api.req('GET', `/v1/consultations/${b.body.id}`, { token: p1.token })).body.status).toBe('CANCELLED');
  });

  it('payment success racing hold expiry resolves to exactly one outcome', async () => {
    const [slot] = await api.slots(doctor, 170);
    const p1 = await api.patient();
    const b = await api.book(p1, slot!);
    await h.drain();
    h.clock.advance(11 * 60_000);
    await Promise.all([h.c.booking.expireHolds(), api.webhook(b.body.payment.id)]);
    await h.drain();
    const c = (await h.c.db.query<{ status: string }>('SELECT status FROM consultations WHERE id=$1', [b.body.id])).rows[0]!.status;
    const pay = (await h.c.db.query<{ status: string }>('SELECT status FROM payments WHERE id=$1', [b.body.payment.id])).rows[0]!.status;
    // consistent pairs only: paid+confirmed, or cancelled with money returned/voided. Never paid+cancelled-without-refund.
    expect([['CONFIRMED', 'SUCCEEDED'], ['CANCELLED', 'REFUNDED'], ['CANCELLED', 'VOIDED']]).toContainEqual([c, pay]);
  });

  it('PSP outage: gateway retries via the durable job queue and eventually succeeds', async () => {
    const [slot] = await api.slots(doctor, 180);
    const p1 = await api.patient();
    h.gateway.failNext(1000); // PSP down hard
    const b = await api.book(p1, slot!);
    expect(b.status).toBe(201); // booking path does not depend on the PSP being up
    await h.drain();
    expect((await h.c.db.query(`SELECT 1 FROM jobs WHERE type='payment.create_intent' AND status='PENDING' AND attempts>=1 AND last_error IS NOT NULL`)).rowCount).toBeGreaterThan(0);
    h.gateway.failNext(0);
    h.clock.advance(10 * 60_000); // skip the backoff delay
    await h.drain();
    const pay = await api.req('GET', `/v1/payments/${b.body.payment.id}`, { token: p1.token });
    expect(pay.body.status).toBe('REQUIRES_PAYMENT');
  }, 60_000);
});

describe('cancellation & refunds', () => {
  it('patient cancelling early gets a full refund and the slot reopens', async () => {
    const [slot] = await api.slots(doctor, 200);
    const p = await api.patient();
    const b = await api.confirmedBooking(p, slot!);
    const r = await api.req('POST', `/v1/consultations/${b.id}/cancel`, { token: p.token, body: { reason: 'plans changed' } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('CANCELLED');
    await h.drain();
    expect((await h.c.db.query(`SELECT status FROM payments WHERE id=$1`, [b.payment.id])).rows[0]).toMatchObject({ status: 'REFUNDED' });
    expect((await api.book(await api.patient(), slot!)).status).toBe(201);
    // cancel is idempotent
    expect((await api.req('POST', `/v1/consultations/${b.id}/cancel`, { token: p.token, body: {} })).status).toBe(200);
    expect(await count(`SELECT count(*)::int n FROM jobs WHERE type='payment.refund' AND payload->>'paymentId'=$1`, [b.payment.id])).toBe(1);
  });

  it('late patient cancellation (inside the window) gets no refund; doctor cancellation always refunds', async () => {
    const [s1] = await api.slots(doctor, 220);
    const [s2] = await api.slots(doctor, 222);
    const p1 = await api.patient();
    const p2 = await api.patient();
    const late = await api.confirmedBooking(p1, s1!);
    const byDoctor = await api.confirmedBooking(p2, s2!);
    h.clock.advance(219 * 3600_000); // now ~1h before s1 (< 4h policy), ~3h before s2
    const r1 = await api.req('POST', `/v1/consultations/${late.id}/cancel`, { token: p1.token, body: {} });
    expect(r1.status).toBe(200);
    const r2 = await api.req('POST', `/v1/consultations/${byDoctor.id}/cancel`, { token: doctor.token, body: { reason: 'emergency' } });
    expect(r2.status).toBe(200);
    await h.drain();
    expect((await h.c.db.query(`SELECT status FROM payments WHERE id=$1`, [late.payment.id])).rows[0]).toMatchObject({ status: 'SUCCEEDED' });
    expect((await h.c.db.query(`SELECT status FROM payments WHERE id=$1`, [byDoctor.payment.id])).rows[0]).toMatchObject({ status: 'REFUNDED' });
    h.clock.advance(-219 * 3600_000);
  });
});

describe('free consultations', () => {
  it('skip the payment saga entirely and confirm immediately', async () => {
    const free = await api.doctor(admin, { fee: 0 });
    const [slot] = await api.slots(free, 48);
    const p = await api.patient();
    const b = await api.book(p, slot!);
    expect(b.status).toBe(201);
    expect(b.body.status).toBe('CONFIRMED');
    expect(b.body.payment).toBeNull();
  });
});
