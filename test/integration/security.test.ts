import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpNow } from '../../src/shared/totp';
import { Api, createHarness, PASSWORD, type Harness, type Session } from '../helpers/harness';

let h: Harness; let api: Api; let admin: Session; let doctor: Session;
beforeAll(async () => { h = await createHarness(); api = new Api(h); admin = await api.admin(); doctor = await api.doctor(admin); });
afterAll(() => h.close());

describe('authentication', () => {
  it('locks the account after repeated failures and gives no user-enumeration signal', async () => {
    const p = await api.patient();
    const unknown = await api.req('POST', '/v1/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-password-1' } });
    for (let i = 0; i < 5; i++) await api.req('POST', '/v1/auth/login', { body: { email: p.email, password: 'wrong-password-123' } });
    const locked = await api.req('POST', '/v1/auth/login', { body: { email: p.email, password: PASSWORD } });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe(unknown.body.code);
    expect(locked.body.detail).toBe(unknown.body.detail);
  });
  it('rotates refresh tokens and revokes the whole family on reuse (theft detection)', async () => {
    const p = await api.patient();
    const r1 = await api.req('POST', '/v1/auth/refresh', { body: { refreshToken: p.refreshToken } });
    expect(r1.status).toBe(200);
    const reuse = await api.req('POST', '/v1/auth/refresh', { body: { refreshToken: p.refreshToken } });
    expect(reuse.status).toBe(401);
    expect((await api.req('POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);
    expect((await api.req('GET', '/v1/me', { token: p.token })).status).toBe(401); // access token of the revoked session
  });
  it('enforces MFA for doctors, rejects TOTP replay, and supports single-use recovery codes', async () => {
    const e = `d-${randomUUID().slice(0, 6)}@example.com`;
    const reg = await api.req('POST', '/v1/auth/register', { body: { email: e, password: PASSWORD, fullName: 'Dr M', role: 'doctor', doctor: { licenseNumber: randomUUID(), specialties: ['x'], consultationFeeMinor: 1 } } });
    const l = await api.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    expect(l.body.mfaEnrollmentRequired).toBe(true);
    expect((await api.req('GET', '/v1/doctors/me', { token: l.body.accessToken })).body.code).toBe('MFA_REQUIRED');
    const enroll = await api.req('POST', '/v1/auth/mfa/enroll', { token: l.body.accessToken });
    const now = h.clock.now().getTime();
    const act = await api.req('POST', '/v1/auth/mfa/activate', { token: l.body.accessToken, body: { code: totpNow(enroll.body.secret, now) } });
    expect(act.status).toBe(200);
    expect(act.body.recoveryCodes).toHaveLength(10);
    const step = await api.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    expect(step.body.mfaRequired).toBe(true);
    const replay = await api.req('POST', '/v1/auth/mfa/verify', { body: { mfaToken: step.body.mfaToken, code: totpNow(enroll.body.secret, now) } });
    expect(replay.status).toBe(401); // same counter already consumed at activation
    const ok = await api.req('POST', '/v1/auth/mfa/verify', { body: { mfaToken: step.body.mfaToken, code: totpNow(enroll.body.secret, now + 30_000) } });
    expect(ok.status).toBe(200);
    const rc = act.body.recoveryCodes[0];
    const step2 = await api.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    expect((await api.req('POST', '/v1/auth/mfa/verify', { body: { mfaToken: step2.body.mfaToken, recoveryCode: rc } })).status).toBe(200);
    const step3 = await api.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    expect((await api.req('POST', '/v1/auth/mfa/verify', { body: { mfaToken: step3.body.mfaToken, recoveryCode: rc } })).status).toBe(401);
    void reg;
  });
  it('rejects forged, expired-shape and wrong-purpose tokens', async () => {
    expect((await api.req('GET', '/v1/me', { token: 'garbage' })).status).toBe(401);
    const l = await api.req('POST', '/v1/auth/login', { body: { email: doctor.email, password: PASSWORD } });
    expect((await api.req('GET', '/v1/me', { token: l.body.mfaToken })).status).toBe(401); // MFA challenge token is not an access token
    const [hd, , sig] = (await api.patient()).token.split('.');
    const forged = `${hd}.${Buffer.from(JSON.stringify({ sub: admin.id, role: 'admin', sid: 'x', amr: ['pwd', 'otp'], exp: 9999999999 })).toString('base64url')}.${sig}`;
    expect((await api.req('GET', '/v1/admin/jobs/dead', { token: forged })).status).toBe(401);
  });
});

describe('authorization (RBAC + object-level)', () => {
  it('blocks cross-role access', async () => {
    const p = await api.patient();
    expect((await api.req('POST', '/v1/doctors/me/availability', { token: p.token, body: { windows: [], slotMinutes: 30 } })).status).toBe(403);
    expect((await api.req('GET', '/v1/admin/audit-logs', { token: p.token })).status).toBe(403);
    expect((await api.req('GET', '/v1/admin/audit-logs', { token: doctor.token })).status).toBe(403);
    expect((await api.req('GET', '/v1/consultations')).status).toBe(401);
  });
  it('prevents IDOR: other patients/doctors cannot read consultations, prescriptions, payments', async () => {
    const [slot] = await api.slots(doctor, 300);
    const owner = await api.patient();
    const intruder = await api.patient();
    const otherDoc = await api.doctor(admin);
    const b = await api.confirmedBooking(owner, slot!);
    for (const t of [intruder.token, otherDoc.token]) expect((await api.req('GET', `/v1/consultations/${b.id}`, { token: t })).status).toBe(404);
    expect((await api.req('GET', `/v1/payments/${b.payment.id}`, { token: intruder.token })).status).toBe(404);
    expect((await api.req('POST', `/v1/consultations/${b.id}/cancel`, { token: intruder.token, body: {} })).status).toBe(404);
    expect((await api.req('POST', `/v1/consultations/${b.id}/start`, { token: otherDoc.token })).status).toBe(404);
  });
  it('admins can manage the platform but never read clinical data', async () => {
    const [slot] = await api.slots(doctor, 310);
    const p = await api.patient();
    const b = await api.confirmedBooking(p, slot!);
    expect((await api.req('GET', `/v1/consultations/${b.id}`, { token: admin.token })).status).toBe(403);
    expect((await api.req('GET', '/v1/prescriptions', { token: admin.token })).status).toBe(403);
  });
  it('suspending a user immediately kills their sessions', async () => {
    const p = await api.patient();
    expect((await api.req('POST', `/v1/admin/users/${p.id}/suspend`, { token: admin.token })).status).toBe(204);
    expect((await api.req('GET', '/v1/me', { token: p.token })).status).toBe(401);
    expect((await api.req('POST', '/v1/auth/login', { body: { email: p.email, password: PASSWORD } })).status).toBe(401);
  });
});

describe('input validation & hardening', () => {
  it('rejects unknown fields, oversized bodies, bad JSON and SQL-ish input safely', async () => {
    const p = await api.patient();
    expect((await api.req('POST', '/v1/consultations', { token: p.token, body: { slotId: randomUUID(), isAdmin: true }, headers: { 'idempotency-key': randomUUID() } })).status).toBe(400);
    expect((await api.req('POST', '/v1/auth/login', { raw: '{bad json' })).status).toBe(400);
    expect((await api.req('POST', '/v1/auth/register', { raw: JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(300_000) }) })).status).toBe(413);
    const inj = await api.req('GET', `/v1/doctors?q=${encodeURIComponent("'; DROP TABLE users;--")}`);
    expect(inj.status).toBeLessThan(500);
    expect((await h.c.db.query('SELECT 1 FROM users LIMIT 1')).rowCount).toBe(1);
    expect((await api.req('GET', '/v1/doctors/not-a-uuid')).status).toBe(400);
  });
  it('sends security headers and never leaks internals in errors', async () => {
    const r = await api.req('GET', '/v1/me');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toBeTruthy();
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.raw).not.toMatch(/stack|node_modules|postgres/i);
  });
  it('rate limits abusive clients (429 + Retry-After)', async () => {
    const lim = await createHarness({ RATE_LIMIT_AUTH_PER_MIN: '3' });
    const a = new Api(lim);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await a.req('POST', '/v1/auth/login', { body: { email: 'x@example.com', password: 'abcdefghijkl' } })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3);
    expect((await a.req('POST', '/v1/auth/login', { body: { email: 'x@example.com', password: 'abcdefghijkl' } })).headers['retry-after']).toBeTruthy();
    await lim.close();
  });
});
