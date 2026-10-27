import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, createHarness, type Harness, type Session } from '../helpers/harness';

let h: Harness; let api: Api; let admin: Session; let doctor: Session;
beforeAll(async () => { h = await createHarness(); api = new Api(h); admin = await api.admin(); doctor = await api.doctor(admin, { specialties: ['clin-' + randomUUID().slice(0, 6)] }); });
afterAll(() => h.close());
const rx = { diagnosis: 'Common cold', medications: [{ name: 'Tulsi tea', dosage: '1 cup', frequency: 'twice daily', durationDays: 5 }] };

describe('consultation lifecycle + prescriptions', () => {
  it('start window, complete, prescribe (idempotent), revise, verify signature, review, audit', async () => {
    const [slot] = await api.slots(doctor, 24);
    const p = await api.patient();
    const b = await api.confirmedBooking(p, slot!);
    expect((await api.req('POST', `/v1/consultations/${b.id}/start`, { token: doctor.token })).body.code).toBe('TOO_EARLY');
    h.clock.advance(23.9 * 3600_000);
    expect((await api.req('POST', `/v1/consultations/${b.id}/start`, { token: doctor.token })).body.status).toBe('IN_PROGRESS');
    const key = randomUUID();
    const r1 = await api.req('POST', `/v1/consultations/${b.id}/prescriptions`, { token: doctor.token, body: rx, headers: { 'idempotency-key': key } });
    const r1b = await api.req('POST', `/v1/consultations/${b.id}/prescriptions`, { token: doctor.token, body: rx, headers: { 'idempotency-key': key } });
    expect(r1.status).toBe(201);
    expect(r1b.body.id).toBe(r1.body.id);
    const r2 = await api.req('POST', `/v1/consultations/${b.id}/prescriptions`, { token: doctor.token, body: { ...rx, diagnosis: 'Revised' }, headers: { 'idempotency-key': randomUUID() } });
    expect(r2.body.version).toBe(2);
    const list = await api.req('GET', `/v1/consultations/${b.id}/prescriptions`, { token: p.token });
    expect(list.body.items.map((i: any) => [i.version, i.status])).toEqual([[2, 'ACTIVE'], [1, 'SUPERSEDED']]);
    expect(list.body.items.every((i: any) => i.signatureValid)).toBe(true);
    const done = await api.req('POST', `/v1/consultations/${b.id}/complete`, { token: doctor.token, body: { notes: 'resting advised' } });
    expect(done.body.status).toBe('COMPLETED');
    expect((await api.req('GET', `/v1/consultations/${b.id}`, { token: p.token })).body.notes).toBeUndefined(); // doctor-only
    expect((await api.req('POST', `/v1/consultations/${b.id}/review`, { token: p.token, body: { rating: 5 } })).status).toBe(201);
    expect((await api.req('POST', `/v1/consultations/${b.id}/review`, { token: p.token, body: { rating: 1 } })).status).toBe(409);
    expect((await api.req('GET', `/v1/doctors/${doctor.doctorId}`)).body.rating).toEqual({ average: 5, count: 1 });
    // tamper detection: flip the stored signature
    await h.c.db.query(`UPDATE prescriptions SET signature = 'hmac-sha256:forged' WHERE id=$1`, [r2.body.id]);
    expect((await api.req('GET', `/v1/prescriptions/${r2.body.id}`, { token: p.token })).body.signatureValid).toBe(false);
    // PHI reads are audited
    expect((await h.c.db.query(`SELECT 1 FROM audit_logs WHERE action='prescription.read' AND entity_id=$1`, [r2.body.id])).rowCount).toBeGreaterThan(0);
    h.clock.advance(-23.9 * 3600_000);
  });
  it('unstarted consultations become NO_SHOW after the grace period', async () => {
    const [slot] = await api.slots(doctor, 12);
    const b = await api.confirmedBooking(await api.patient(), slot!);
    h.clock.advance(14 * 3600_000);
    expect(await h.c.lifecycle.markNoShows()).toBeGreaterThanOrEqual(1);
    expect((await h.c.db.query(`SELECT status FROM consultations WHERE id=$1`, [b.id])).rows[0]).toMatchObject({ status: 'NO_SHOW' });
    h.clock.advance(-14 * 3600_000);
  });
});

describe('audit trail', () => {
  it('is append-only at the database level and tamper-evident', async () => {
    await expect(h.c.db.query(`UPDATE audit_logs SET action='x'`)).rejects.toThrow(/append-only/);
    await expect(h.c.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
    await expect(h.c.db.query(`TRUNCATE audit_logs`)).rejects.toThrow(/append-only/);
    const from = new Date(Date.now() - 3600_000), to = new Date(Date.now() + 3600_000);
    h.clock.advance(10 * 60_000);
    expect(await h.c.audit.checkpoint()).not.toBeNull();
    expect((await h.c.audit.verify(from, new Date(to.getTime() + 3600_000))).ok).toBe(true);
    // an attacker with raw DB access disables the trigger and edits a row
    await h.c.db.query('ALTER TABLE audit_logs_default DISABLE TRIGGER ALL').catch(() => undefined);
    const victim = (await h.c.db.query<{ id: number }>(`SELECT id FROM audit_logs WHERE action='consultation.book' LIMIT 1`)).rows[0]!;
    const tbl = (await h.c.db.query<{ t: string }>(`SELECT tableoid::regclass::text t FROM audit_logs WHERE id=$1`, [victim.id])).rows[0]!.t;
    await h.c.db.query(`ALTER TABLE ${tbl} DISABLE TRIGGER audit_logs_no_update_delete`);
    await h.c.db.query(`UPDATE ${tbl} SET outcome='FAILURE' WHERE id=$1`, [victim.id]);
    await h.c.db.query(`ALTER TABLE ${tbl} ENABLE TRIGGER audit_logs_no_update_delete`);
    const rep = await h.c.audit.verify(from, new Date(to.getTime() + 3600_000));
    expect(rep.ok).toBe(false);
    expect(rep.badSignatures).toContain(victim.id);
  });
  it('is readable by auditors via the API, filtered, and reading is itself audited', async () => {
    const auditor = await api.admin('auditor');
    const r = await api.req('GET', '/v1/admin/audit-logs?action=consultation.book&limit=5', { token: auditor.token });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toMatch(/very private|fever/);
    expect((await h.c.db.query(`SELECT 1 FROM audit_logs WHERE action='audit.read' AND actor_id=$1`, [auditor.id])).rowCount).toBeGreaterThan(0);
  });
});

describe('search, analytics, jobs, key rotation', () => {
  it('filters, sorts and paginates (keyset) doctors', async () => {
    const tag = 'srch-' + randomUUID().slice(0, 6);
    const docs = [] as Session[];
    for (const [fee, yrs] of [[300, 2], [100, 9], [200, 5]]) docs.push(await api.doctor(admin, { specialties: [tag], fee, years: yrs, city: 'Jaipur', languages: ['hi'] }));
    await api.doctor(admin, { specialties: [tag], fee: 999, verify: false }); // unverified must never appear
    const all = await api.req('GET', `/v1/doctors?specialty=${tag}&sort=fee_asc`);
    expect(all.body.items.map((d: any) => d.consultationFee.amountMinor)).toEqual([100, 200, 300]);
    const p1 = await api.req('GET', `/v1/doctors?specialty=${tag}&sort=fee_asc&limit=2`);
    const p2 = await api.req('GET', `/v1/doctors?specialty=${tag}&sort=fee_asc&limit=2&cursor=${p1.body.nextCursor}`);
    expect([...p1.body.items, ...p2.body.items].map((d: any) => d.consultationFee.amountMinor)).toEqual([100, 200, 300]);
    expect(p2.body.nextCursor).toBeUndefined();
    expect((await api.req('GET', `/v1/doctors?specialty=${tag}&maxFeeMinor=150&language=hi&city=jaipur`)).body.items).toHaveLength(1);
    expect((await api.req('GET', `/v1/doctors?specialty=${tag}&minExperience=5`)).body.items).toHaveLength(2);
    expect((await api.req('GET', `/v1/doctors?q=Dr&specialty=${tag}`)).body.items.length).toBe(3);
  });
  it('admin analytics come from the rollup', async () => {
    await h.c.analytics.rollup(new Date(Date.now() - 86400_000), new Date(Date.now() + 40 * 86400_000));
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const r = await api.req('GET', `/v1/admin/analytics/summary?from=${day(new Date(Date.now() - 86400_000))}&to=${day(new Date(Date.now() + 40 * 86400_000))}`, { token: admin.token });
    expect(r.status).toBe(200);
    expect(r.body.totals.scheduled).toBeGreaterThan(0);
    expect((await api.req('GET', '/v1/admin/analytics/summary?from=2026-01-01&to=2026-02-01', { token: (await api.patient()).token })).status).toBe(403);
  });
  it('jobs: retry with backoff, dead-letter, lease reclaim, dedupe, requeue; scheduler runs once per interval', async () => {
    let calls = 0;
    const { JobWorker } = await import('../../src/modules/jobs/worker.js');
    const w = new JobWorker(h.c.queue, { flaky: async () => { if (++calls < 3) throw new Error('nope'); }, dead: async () => { throw new Error('always'); } }, { concurrency: 5, pollMs: 5, leaseSeconds: 60 }, h.c.logger, h.c.metrics);
    await h.c.queue.enqueue(h.c.db, 'flaky', {}, { dedupeKey: 'k1' });
    await h.c.queue.enqueue(h.c.db, 'flaky', {}, { dedupeKey: 'k1' }); // deduped
    await h.c.queue.enqueue(h.c.db, 'dead', {}, { maxAttempts: 2 });
    for (let i = 0; i < 6; i++) { await w.runOnce(); h.clock.advance(10 * 60_000); }
    expect(calls).toBe(3);
    const dead = await h.c.queue.listDead();
    expect(dead.length).toBeGreaterThanOrEqual(1);
    await h.c.queue.enqueue(h.c.db, 'flaky', {});
    const [claimed] = await h.c.queue.claim('crashed-worker', 1, 1);
    expect(claimed).toBeTruthy();
    h.clock.advance(5000);
    expect(await h.c.queue.reclaimExpired()).toBeGreaterThanOrEqual(1);
    expect(await h.c.queue.requeueDead((dead[0] as any).id)).toBe(true);
    const { Scheduler } = await import('../../src/modules/jobs/worker.js');
    let runs = 0;
    const mk = () => new Scheduler(h.c.db, [{ name: 'once-' + h.clock.now().getTime(), intervalSeconds: 60, run: async () => void runs++ }], h.clock, h.c.logger, h.c.metrics);
    const s1 = mk(), s2 = mk();
    await s1.register();
    await Promise.all([s1.tick(true), s2.tick(true)]);
    expect(runs).toBe(1);
  });
  it('rotates data keys online without losing data', async () => {
    const p = await api.patient();
    const old = new (await import('../../src/shared/crypto.js')).FieldCrypto((h.c.cfg.keys.dataKeys), 'k2', h.c.cfg.keys.blindIndexKey);
    Object.assign(h.c.crypto, { activeKeyId: 'k2' });
    let r = await h.c.keyRotation.reencryptBatch(1000);
    while (r.remaining > 0 && r.rotated > 0) r = await h.c.keyRotation.reencryptBatch(1000);
    expect(r.remaining).toBe(0);
    expect((await api.req('GET', '/v1/me', { token: p.token })).body.profile.fullName).toBe('Test Patient');
    expect((await h.c.db.query(`SELECT email_enc FROM users WHERE id=$1`, [p.id])).rows[0]!.email_enc).toMatch(/^enc:v1:k2:/);
    void old;
    Object.assign(h.c.crypto, { activeKeyId: 'k1' });
  });
});
