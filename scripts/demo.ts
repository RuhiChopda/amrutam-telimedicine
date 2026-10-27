/**
 * Narrated end-to-end demo of the core workflows against a RUNNING stack (API + worker + Postgres [+ Redis]).
 *
 *   MIN_BOOKING_LEAD_MINUTES=0 RATE_LIMIT_AUTH_PER_MIN=1000 ENABLE_DEV_ENDPOINTS=true npm run dev        # terminal 1
 *   METRICS_PORT=9465 npm run dev:worker                                                                   # terminal 2
 *   npm run demo                                                                                           # terminal 3
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env';
import { AAD } from '../src/shared/aad';
import { FieldCrypto, hashPassword } from '../src/shared/crypto';
import { createDb } from '../src/shared/db';
import { createLogger } from '../src/shared/logger';
import { Metrics } from '../src/shared/metrics';
import { totpNow } from '../src/shared/totp';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD = 'Correct-Horse-9Battery';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m` };
let step = 0;
const title = (t: string) => console.log(`\n${c.b(`━━ ${++step}. ${t}`)}`);
const say = (t: string) => console.log(`   ${t}`);

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  console.log(c.dim(`   ${method} ${path} → ${res.status}${res.headers.get('idempotent-replayed') ? ' (idempotent replay)' : ''}`));
  return { status: res.status, body, headers: res.headers };
}
const must = (r: { status: number; body: any }, ...ok: number[]) => {
  if (!ok.includes(r.status)) throw new Error(`unexpected ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
};

async function mfaSession(email: string) {
  const l = must(await call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } }), 200);
  const e = must(await call('POST', '/v1/auth/mfa/enroll', { token: l.accessToken }), 200);
  return must(await call('POST', '/v1/auth/mfa/activate', { token: l.accessToken, body: { code: totpNow(e.secret) } }), 200) as { accessToken: string };
}

async function main() {
  const cfg = loadConfig();
  const crypto = new FieldCrypto(cfg.keys.dataKeys, cfg.keys.activeDataKeyId, cfg.keys.blindIndexKey);
  const db = createDb(cfg, createLogger({ level: 'silent', service: 'demo' }), new Metrics({ defaultMetrics: false }));
  const tag = randomUUID().slice(0, 6);

  title('Bootstrap an administrator (admins cannot self-register) and enrol MFA');
  const adminEmail = `admin-${tag}@demo.example`;
  const adminId = randomUUID();
  await db.query(`INSERT INTO users (id,email_bidx,email_enc,password_hash,role) VALUES ($1,$2,$3,$4,'admin')`, [adminId, crypto.blindIndex(adminEmail), crypto.encrypt(adminEmail, AAD.userEmail(adminId)), await hashPassword(PASSWORD)]);
  await db.query(`INSERT INTO profiles (user_id, full_name_enc) VALUES ($1,$2)`, [adminId, crypto.encrypt('Demo Admin', AAD.profileName(adminId))]);
  const admin = await mfaSession(adminEmail);
  say(c.g('✓ admin has an MFA-verified session (TOTP)'));

  title('Doctor registers (PENDING), enrols MFA, admin verifies');
  const docEmail = `doctor-${tag}@demo.example`;
  must(await call('POST', '/v1/auth/register', { body: { email: docEmail, password: PASSWORD, fullName: `Dr. Meera ${tag}`, role: 'doctor', doctor: { licenseNumber: `MH-${tag}`, specialties: [`ayurveda-${tag}`], languages: ['en', 'hi'], city: 'Pune', yearsExperience: 12, consultationFeeMinor: 60000 } } }), 201);
  const doc = await mfaSession(docEmail);
  const me = must(await call('GET', '/v1/doctors/me', { token: doc.accessToken }), 200);
  say(`status before verification: ${c.y(me.verificationStatus)}`);
  const early = await call('POST', '/v1/doctors/me/availability', { token: doc.accessToken, body: { windows: [{ start: new Date(Date.now() + 120_000).toISOString(), end: new Date(Date.now() + 3_720_000).toISOString() }], slotMinutes: 10 } });
  say(`publishing availability while unverified → ${c.r(String(early.status))} ${early.body.code}`);
  must(await call('POST', `/v1/admin/doctors/${me.id}/verification`, { token: admin.accessToken, body: { decision: 'VERIFIED' } }), 200);

  title('Doctor publishes availability (split into 10-minute slots; overlap-proof at the DB level)');
  const start = new Date(Math.ceil((Date.now() + 90_000) / 60_000) * 60_000);
  const avail = must(await call('POST', '/v1/doctors/me/availability', { token: doc.accessToken, body: { windows: [{ start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }], slotMinutes: 10 } }), 201);
  say(`${avail.created} slots created`);
  const again = must(await call('POST', '/v1/doctors/me/availability', { token: doc.accessToken, body: { windows: [{ start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }], slotMinutes: 10 } }), 201);
  say(`re-running the same request is harmless: created=${again.created}, skipped=${again.skippedOverlapping}`);

  title('Patient searches doctors (cached, keyset-paginated) and picks a slot');
  const pEmail = `patient-${tag}@demo.example`;
  must(await call('POST', '/v1/auth/register', { body: { email: pEmail, password: PASSWORD, fullName: 'Asha Rao', phone: '+919800000001' } }), 201);
  const pt = must(await call('POST', '/v1/auth/login', { body: { email: pEmail, password: PASSWORD } }), 200);
  const found = must(await call('GET', `/v1/doctors?q=meera&specialty=ayurveda-${tag}&language=hi&sort=relevance`), 200);
  say(`found: ${found.items.map((d: any) => `${d.displayName} (₹${d.consultationFee.amountMinor / 100})`).join(', ')}`);
  const slots = must(await call('GET', `/v1/doctors/${found.items[0].id}/slots`), 200).slots as Array<{ id: string }>;

  title('Booking race: 8 patients fight for the SAME slot at once');
  const rivals = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
    const em = `rival${i}-${tag}@demo.example`;
    await call('POST', '/v1/auth/register', { body: { email: em, password: PASSWORD, fullName: `Rival ${i}` } });
    return must(await call('POST', '/v1/auth/login', { body: { email: em, password: PASSWORD } }), 200).accessToken as string;
  }));
  const raceSlot = slots[5]!.id;
  const race = await Promise.all(rivals.map((t) => call('POST', '/v1/consultations', { token: t, body: { slotId: raceSlot }, headers: { 'idempotency-key': randomUUID() } })));
  say(`results: ${c.g(race.filter((r) => r.status === 201).length + ' booked')}, ${c.y(race.filter((r) => r.status === 409).length + ' rejected (SLOT_UNAVAILABLE)')}`);

  title('Idempotent booking: the client retries the SAME request 3 times (network flake)');
  const key = randomUUID();
  const bookReq = { token: pt.accessToken, body: { slotId: slots[0]!.id, reason: 'Recurring headaches for two weeks' }, headers: { 'idempotency-key': key } };
  const b1 = must(await call('POST', '/v1/consultations', bookReq), 201);
  const b2 = must(await call('POST', '/v1/consultations', bookReq), 201);
  const b3 = must(await call('POST', '/v1/consultations', bookReq), 201);
  say(`same consultation every time: ${b1.id === b2.id && b2.id === b3.id ? c.g('yes ' + b1.id) : c.r('NO')}   status=${b1.status}`);
  const misuse = await call('POST', '/v1/consultations', { ...bookReq, body: { slotId: slots[1]!.id } });
  say(`same key, different payload → ${c.y(String(misuse.status))} ${misuse.body.code}`);

  title('Payment saga: worker creates the PSP intent from the outbox, PSP confirms via signed webhook');
  for (let i = 0; i < 20; i++) {
    const p = must(await call('GET', `/v1/payments/${b1.payment.id}`, { token: pt.accessToken }), 200);
    if (p.status === 'REQUIRES_PAYMENT') { say(`payment ${c.g(p.status)} (client secret issued)`); break; }
    await sleep(500);
  }
  const evt = `evt_${randomUUID()}`;
  must(await call('POST', `/v1/dev/payments/${b1.payment.id}/simulate`, { token: pt.accessToken, body: { outcome: 'succeeded', eventId: evt } }), 200);
  must(await call('POST', `/v1/dev/payments/${b1.payment.id}/simulate`, { token: pt.accessToken, body: { outcome: 'succeeded', eventId: evt } }), 200);
  say('PSP delivered the webhook twice; it was applied once');
  say(`consultation is now ${c.g(must(await call('GET', `/v1/consultations/${b1.id}`, { token: pt.accessToken }), 200).status)}`);

  title('Consultation: doctor starts, issues a prescription (idempotent), completes');
  must(await call('POST', `/v1/consultations/${b1.id}/start`, { token: doc.accessToken }), 200);
  const rxKey = randomUUID();
  const rx = { diagnosis: 'Tension-type headache', medications: [{ name: 'Brahmi ghrita', dosage: '5 g', frequency: 'twice daily', durationDays: 14, instructions: 'with warm milk' }], advice: 'Hydrate; reduce screen time' };
  const r1 = must(await call('POST', `/v1/consultations/${b1.id}/prescriptions`, { token: doc.accessToken, body: rx, headers: { 'idempotency-key': rxKey } }), 201);
  const r2 = must(await call('POST', `/v1/consultations/${b1.id}/prescriptions`, { token: doc.accessToken, body: rx, headers: { 'idempotency-key': rxKey } }), 201);
  say(`replayed retry returned the same prescription: ${r1.id === r2.id ? c.g('yes') : c.r('NO')}`);
  must(await call('POST', `/v1/consultations/${b1.id}/complete`, { token: doc.accessToken, body: { notes: 'Advised rest and hydration; follow-up in 2 weeks.' } }), 200);
  const view = must(await call('GET', `/v1/prescriptions/${r1.id}`, { token: pt.accessToken }), 200);
  say(`patient reads prescription v${view.version}; signature valid: ${view.signatureValid ? c.g('yes') : c.r('NO')}`);
  must(await call('POST', `/v1/consultations/${b1.id}/review`, { token: pt.accessToken, body: { rating: 5, comment: 'Very helpful' } }), 201);

  title('Security spot-checks');
  const other = rivals[0]!;
  say(`another patient reading this consultation → ${c.y(String((await call('GET', `/v1/consultations/${b1.id}`, { token: other })).status))} (404, existence not revealed)`);
  say(`admin reading clinical data → ${c.y(String((await call('GET', `/v1/prescriptions/${r1.id}`, { token: admin.accessToken })).status))} (403, RBAC)`);
  const row = (await db.query<{ reason_enc: string }>('SELECT reason_enc FROM consultations WHERE id=$1', [b1.id])).rows[0]!;
  say(`complaint at rest in Postgres: ${c.dim(row.reason_enc.slice(0, 48) + '…')} (AES-256-GCM)`);

  title('Compliance: audit trail + integrity verification');
  const audit = must(await call('GET', `/v1/admin/audit-logs?limit=5`, { token: admin.accessToken }), 200);
  for (const a of audit.items) say(`${c.dim(a.created_at)} ${a.action.padEnd(28)} ${a.outcome} ${c.dim(a.actor_role ?? '')}`);
  const verify = must(await call('POST', '/v1/admin/audit-logs/verify', { token: admin.accessToken, body: { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() } }), 200);
  say(`integrity check: ${verify.ok ? c.g('OK') : c.r('TAMPERED')} (${verify.rowsChecked} rows verified)`);

  console.log(`\n${c.g('Demo complete.')} Metrics: curl localhost:9464/metrics | grep -E 'bookings_total|saga|idempotent'`);
  await db.close();
}
main().catch((e) => { console.error(c.r(`\nDemo failed: ${e.message}`)); process.exit(1); });
