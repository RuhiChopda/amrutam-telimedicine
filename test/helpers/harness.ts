import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { AAD } from '../../src/shared/aad';
import { hashPassword } from '../../src/shared/crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config/env';
import { buildContainer, type Container } from '../../src/container';
import { buildApp } from '../../src/http/app';
import { JobWorker } from '../../src/modules/jobs/worker';
import { MockGateway } from '../../src/modules/payments/gateway';
import { LogNotifier } from '../../src/modules/notifications/notifier';
import { createLogger } from '../../src/shared/logger';
import { FakeClock } from '../../src/shared/clock';
import { totpNow } from '../../src/shared/totp';
import { signWebhook } from '../../src/modules/payments/gateway';

export const PASSWORD = 'Correct-Horse-9Battery';

export interface Harness {
  app: FastifyInstance;
  c: Container;
  clock: FakeClock;
  gateway: MockGateway;
  notifier: LogNotifier;
  worker: JobWorker;
  drain(max?: number): Promise<number>;
  close(): Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const cfg = loadConfig({ ...process.env, ...env });
  const logger = createLogger({ level: 'silent', service: 'test' });
  const clock = new FakeClock(new Date());
  const gateway = new MockGateway();
  const notifier = new LogNotifier(logger);
  const c = await buildContainer(cfg, logger, 'api', { clock, gateway, notifier });
  const app = await buildApp(c);
  await app.ready();
  const worker = new JobWorker(c.queue, c.handlers, { concurrency: 20, pollMs: 10, leaseSeconds: 60 }, logger, c.metrics);
  const drain = async (max = 50) => {
    let total = 0;
    for (let i = 0; i < max; i++) {
      const n = await worker.runOnce();
      if (n === 0) break;
      total += n;
    }
    return total;
  };
  return { app, c, clock, gateway, notifier, worker, drain, close: async () => { await app.close(); await c.db.close(); } };
}

export const uniq = (p = 'u') => `${p}-${randomUUID().slice(0, 8)}`;
export const email = (p = 'user') => `${uniq(p)}@example.com`;

export interface Session {
  id: string;
  email: string;
  token: string;
  refreshToken: string;
  role: string;
  mfaSecret?: string;
  doctorId?: string;
}

export class Api {
  constructor(public h: Harness) {}

  async req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
    const res = await this.h.app.inject({
      method,
      url,
      headers: { ...(opts.body !== undefined || opts.raw ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      payload: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
    let json: any;
    try {
      json = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json, headers: res.headers, raw: res.body };
  }

  /** Registers a patient and logs in. */
  async patient(): Promise<Session> {
    const e = email('patient');
    const r = await this.req('POST', '/v1/auth/register', { body: { email: e, password: PASSWORD, fullName: 'Test Patient', phone: '+919800000000' } });
    if (r.status !== 201) throw new Error(`register failed ${r.status} ${r.raw}`);
    const l = await this.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    return { id: r.body.id, email: e, token: l.body.accessToken, refreshToken: l.body.refreshToken, role: 'patient' };
  }

  /** Logs a privileged user in and enrols MFA (required for doctor/admin/auditor). Returns an MFA-verified session. */
  async withMfa(id: string, e: string, role: string): Promise<Session> {
    const l = await this.req('POST', '/v1/auth/login', { body: { email: e, password: PASSWORD } });
    expect(l.body.mfaEnrollmentRequired).toBe(true);
    const enroll = await this.req('POST', '/v1/auth/mfa/enroll', { token: l.body.accessToken });
    const secret = enroll.body.secret as string;
    const act = await this.req('POST', '/v1/auth/mfa/activate', { token: l.body.accessToken, body: { code: totpNow(secret, this.h.clock.now().getTime()) } });
    if (act.status !== 200) throw new Error(`mfa activate failed ${act.status} ${act.raw}`);
    return { id, email: e, token: act.body.accessToken, refreshToken: act.body.refreshToken, role, mfaSecret: secret };
  }

  async admin(role: 'admin' | 'auditor' = 'admin'): Promise<Session> {
    const e = email(role);
    const id = randomUUID();
    const c = this.h.c;
    await c.db.query(`INSERT INTO users (id, email_bidx, email_enc, password_hash, role) VALUES ($1,$2,$3,$4,$5)`, [id, c.auth.emailIndex(e), c.crypto.encrypt(e, AAD.userEmail(id)), await hashPassword(PASSWORD), role]);
    await c.db.query(`INSERT INTO profiles (user_id, full_name_enc) VALUES ($1,$2)`, [id, c.crypto.encrypt('Admin', AAD.profileName(id))]);
    return this.withMfa(id, e, role);
  }

  /** Registers a doctor, has an admin verify them, and returns an MFA-verified doctor session. */
  async doctor(admin: Session, opts: { fee?: number; specialties?: string[]; city?: string; languages?: string[]; years?: number; name?: string; verify?: boolean } = {}): Promise<Session> {
    const e = email('doctor');
    const r = await this.req('POST', '/v1/auth/register', {
      body: {
        email: e, password: PASSWORD, fullName: opts.name ?? 'Dr Test', role: 'doctor',
        doctor: { licenseNumber: uniq('LIC'), specialties: opts.specialties ?? ['ayurveda'], languages: opts.languages ?? ['en'], city: opts.city ?? 'Pune', yearsExperience: opts.years ?? 5, consultationFeeMinor: opts.fee ?? 50000 },
      },
    });
    if (r.status !== 201) throw new Error(`doctor register failed ${r.status} ${r.raw}`);
    const s = await this.withMfa(r.body.id, e, 'doctor');
    const me = await this.req('GET', '/v1/doctors/me', { token: s.token });
    s.doctorId = me.body.id;
    if (opts.verify !== false) {
      const v = await this.req('POST', `/v1/admin/doctors/${s.doctorId}/verification`, { token: admin.token, body: { decision: 'VERIFIED' } });
      if (v.status !== 200) throw new Error(`verify failed ${v.status} ${v.raw}`);
    }
    return s;
  }

  /** Publishes `count` 30-minute slots starting `hoursAhead` from the harness clock; returns their ids in time order. */
  async slots(doctor: Session, hoursAhead = 48, count = 2): Promise<string[]> {
    const start = new Date(this.h.clock.now().getTime() + hoursAhead * 3600_000);
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime() + count * 30 * 60_000);
    const r = await this.req('POST', '/v1/doctors/me/availability', { token: doctor.token, body: { windows: [{ start: start.toISOString(), end: end.toISOString() }], slotMinutes: 30 } });
    if (r.status !== 201) throw new Error(`availability failed ${r.status} ${r.raw}`);
    const list = await this.req('GET', `/v1/doctors/me/slots?from=${start.toISOString()}&to=${end.toISOString()}`, { token: doctor.token });
    return list.body.slots.map((s: { id: string }) => s.id);
  }

  book(patient: Session, slotId: string, key = randomUUID(), reason?: string) {
    return this.req('POST', '/v1/consultations', { token: patient.token, body: { slotId, ...(reason ? { reason } : {}) }, headers: { 'idempotency-key': key } });
  }

  /** Plays the PSP: delivers a signed webhook. */
  webhook(paymentId: string, type: 'payment.succeeded' | 'payment.failed' = 'payment.succeeded', eventId: string = `evt_${randomUUID()}`, secret = 'test-webhook-secret-0123456789') {
    const body = JSON.stringify({ id: eventId, type, data: { paymentId } });
    return this.req('POST', '/v1/webhooks/payments', { raw: body, headers: { 'x-webhook-signature': signWebhook(secret, body) } });
  }

  /** Books a slot and pays for it, returning the CONFIRMED consultation. */
  async confirmedBooking(patient: Session, slotId: string) {
    const b = await this.book(patient, slotId);
    expect(b.status).toBe(201);
    await this.h.drain();
    const w = await this.webhook(b.body.payment.id);
    expect(w.status).toBe(200);
    return b.body as { id: string; payment: { id: string } };
  }
}
