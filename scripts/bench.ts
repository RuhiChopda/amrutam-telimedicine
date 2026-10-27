/**
 * Latency benchmark against a running API (seeds its own data). Reports p50/p95/p99 for reads and the booking write path.
 *   MIN_BOOKING_LEAD_MINUTES=0 RATE_LIMIT_AUTH_PER_MIN=100000 RATE_LIMIT_WRITE_PER_MIN=100000 RATE_LIMIT_GLOBAL_PER_MIN=1000000 npm run dev
 *   npm run bench
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import autocannon from 'autocannon';
import { loadConfig } from '../src/config/env';
import { AAD } from '../src/shared/aad';
import { FieldCrypto, hashPassword } from '../src/shared/crypto';
import { createDb } from '../src/shared/db';
import { createLogger } from '../src/shared/logger';
import { Metrics } from '../src/shared/metrics';
import { totpNow } from '../src/shared/totp';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const PASSWORD = 'Correct-Horse-9Battery';
const post = async (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) => {
  const t0 = performance.now();
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
  return { status: r.status, ms: performance.now() - t0, body: (await r.json().catch(() => ({}))) as any };
};
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN);

async function main() {
  const cfg = loadConfig();
  const crypto = new FieldCrypto(cfg.keys.dataKeys, cfg.keys.activeDataKeyId, cfg.keys.blindIndexKey);
  const db = createDb(cfg, createLogger({ level: 'silent', service: 'bench' }), new Metrics({ defaultMetrics: false }));
  const tag = randomUUID().slice(0, 6);
  const SLOTS = Number(process.env.BENCH_BOOKINGS ?? 480);

  // admin + verified doctor with many slots
  const adminId = randomUUID(), adminEmail = `badmin-${tag}@bench.example`;
  await db.query(`INSERT INTO users (id,email_bidx,email_enc,password_hash,role) VALUES ($1,$2,$3,$4,'admin')`, [adminId, crypto.blindIndex(adminEmail), crypto.encrypt(adminEmail, AAD.userEmail(adminId)), await hashPassword(PASSWORD)]);
  await db.query(`INSERT INTO profiles (user_id, full_name_enc) VALUES ($1,$2)`, [adminId, crypto.encrypt('Bench Admin', AAD.profileName(adminId))]);
  const mfa = async (email: string) => {
    const l = (await post('/v1/auth/login', { email, password: PASSWORD })).body;
    const e = (await post('/v1/auth/mfa/enroll', {}, l.accessToken)).body;
    return (await post('/v1/auth/mfa/activate', { code: totpNow(e.secret) }, l.accessToken)).body.accessToken as string;
  };
  const admin = await mfa(adminEmail);
  const docEmail = `bdoc-${tag}@bench.example`;
  await post('/v1/auth/register', { email: docEmail, password: PASSWORD, fullName: 'Dr Bench', role: 'doctor', doctor: { licenseNumber: `B-${tag}`, specialties: [`bench-${tag}`], consultationFeeMinor: 50000, city: 'Pune', languages: ['en'] } });
  const doc = await mfa(docEmail);
  const did = (await (await fetch(BASE + '/v1/doctors/me', { headers: { authorization: `Bearer ${doc}` } })).json() as any).id;
  await post(`/v1/admin/doctors/${did}/verification`, { decision: 'VERIFIED' }, admin);
  const start = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000);
  const windows = Array.from({ length: Math.ceil(SLOTS / 60) }, (_, i) => ({ start: new Date(start.getTime() + i * 12 * 3_600_000).toISOString(), end: new Date(start.getTime() + i * 12 * 3_600_000 + 60 * 600_000).toISOString() }));
  const av = await post('/v1/doctors/me/availability', { windows, slotMinutes: 10 }, doc);
  if (av.status !== 201) throw new Error(`availability failed: ${av.status} ${JSON.stringify(av.body)}`);
  const slots = ((await (await fetch(`${BASE}/v1/doctors/${did}/slots?from=${start.toISOString()}&to=${new Date(start.getTime() + 13 * 86_400_000).toISOString()}`)).json()) as any).slots as Array<{ id: string }>;
  // 1,000 more doctors so search is non-trivial
  await db.query(
    `INSERT INTO users (id,email_bidx,email_enc,password_hash,role) SELECT gen_random_uuid(), gen_random_bytes(32), 'x', 'x', 'doctor' FROM generate_series(1,2000)`,
  );
  await db.query(
    `INSERT INTO doctors (user_id, display_name, specialties, languages, city, license_number, years_experience, consultation_fee_minor, rating_avg, verification_status)
     SELECT u.id, 'Dr Filler ' || (random()*100000)::int, ARRAY[(ARRAY['ayurveda','yoga','naturopathy','panchakarma','unani'])[1+(random()*4)::int]], ARRAY['en','hi'], (ARRAY['Pune','Delhi','Jaipur','Kochi'])[1+(random()*3)::int],
            'F-' || u.id, (random()*30)::int, (random()*100000)::int, round((random()*5)::numeric,2), 'VERIFIED' FROM users u WHERE u.role='doctor' AND u.email_enc='x' AND NOT EXISTS (SELECT 1 FROM doctors d WHERE d.user_id = u.id)`,
  );
  // patients (scrypt-bound, so created with bounded concurrency)
  const patients: string[] = [];
  const mk = async () => { const e = `bp-${randomUUID().slice(0, 8)}@bench.example`; await post('/v1/auth/register', { email: e, password: PASSWORD, fullName: 'Bench Patient' }); patients.push((await post('/v1/auth/login', { email: e, password: PASSWORD })).body.accessToken); };
  const N = Math.min(SLOTS, 150);
  for (let i = 0; i < N; i += 10) await Promise.all(Array.from({ length: 10 }, mk));

  const run = (url: string, c: number, d: number) => new Promise<autocannon.Result>((res) => autocannon({ url, connections: c, duration: d }, (_e, r) => res(r)));
  console.log('\nREADS (cached, 50 concurrent connections, 10 s each)');
  for (const [name, url] of [['search by specialty+sort', `${BASE}/v1/doctors?specialty=ayurveda&sort=rating&limit=20`], ['search text', `${BASE}/v1/doctors?q=filler&limit=20`], ['doctor profile', `${BASE}/v1/doctors/${did}`], ['open slots', `${BASE}/v1/doctors/${did}/slots`]] as const) {
    const r = await run(url, 50, 10);
    console.log(`  ${name.padEnd(26)} ${String(Math.round(r.requests.average)).padStart(6)} req/s   p50 ${r.latency.p50} ms   p97.5 ${r.latency.p97_5} ms   p99 ${r.latency.p99} ms   errors ${r.errors + r.non2xx}`);
  }
  console.log('\nREADS (UNCACHED search: unique filters every request, forces Postgres)');
  let i = 0;
  const unc = await new Promise<autocannon.Result>((res) => autocannon({ url: BASE, connections: 50, duration: 10, requests: [{ method: 'GET', setupRequest: (r: any) => ({ ...r, path: `/v1/doctors?specialty=ayurveda&minRating=${(i++ % 400) / 100}&maxFeeMinor=${50000 + (i % 5000)}&sort=fee_asc&limit=20` }) }] }, (_e, r) => res(r)));
  console.log(`  ${'search (cache-busted)'.padEnd(26)} ${String(Math.round(unc.requests.average)).padStart(6)} req/s   p50 ${unc.latency.p50} ms   p97.5 ${unc.latency.p97_5} ms   p99 ${unc.latency.p99} ms   errors ${unc.errors + unc.non2xx}`);

  console.log(`\nWRITES: ${SLOTS} bookings, 25 concurrent (each = slot hold + consultation + payment row + outbox job + audit, 1 tx)`);
  const lat: number[] = []; let ok = 0; let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 25 }, async () => {
    while (next < Math.min(SLOTS, slots.length)) {
      const k = next++;
      const tok = patients[k % patients.length]!;
      const r = await post('/v1/consultations', { slotId: slots[k]!.id }, tok, { 'idempotency-key': randomUUID() });
      if (r.status === 201) { ok++; lat.push(r.ms); } else if (r.status !== 409) console.log('unexpected', r.status, r.body.code);
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  console.log(`  booked ${ok}/${next} in ${secs.toFixed(1)} s = ${(ok / secs).toFixed(0)} bookings/s   p50 ${pct(lat, 50).toFixed(0)} ms   p95 ${pct(lat, 95).toFixed(0)} ms   p99 ${pct(lat, 99).toFixed(0)} ms`);
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
