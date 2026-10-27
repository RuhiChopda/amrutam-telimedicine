import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env';
import { signWebhook, verifyWebhookSignature } from '../../src/modules/payments/gateway';
import { can, mfaRequired, permissionsOf } from '../../src/modules/auth/rbac';
import { checkPasswordPolicy } from '../../src/modules/auth/service';
import { REDACT_PATHS, createLogger } from '../../src/shared/logger';
import { decodeCursor, encodeCursor, parse, uuid } from '../../src/shared/validation';
import { z } from 'zod';
import { Writable } from 'node:stream';

describe('webhook signatures', () => {
  const secret = 's3cret-s3cret-s3cret';
  it('accepts a correct signature and rejects tampering, wrong secret, missing header, and stale timestamps', () => {
    const body = '{"id":"e1"}';
    const now = 1_700_000_000;
    const h = signWebhook(secret, body, now);
    expect(verifyWebhookSignature(secret, body, h, now)).toBe(true);
    expect(verifyWebhookSignature(secret, body + ' ', h, now)).toBe(false);
    expect(verifyWebhookSignature('other-other-other-0', body, h, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, now)).toBe(false);
    expect(verifyWebhookSignature(secret, body, h, now + 301)).toBe(false); // replay window
    expect(verifyWebhookSignature(secret, body, 't=abc,v1=zz', now)).toBe(false);
  });
});

describe('RBAC matrix', () => {
  it('enforces least privilege', () => {
    expect(can('patient', 'booking:create')).toBe(true);
    expect(can('patient', 'availability:manage')).toBe(false);
    expect(can('doctor', 'prescription:create')).toBe(true);
    expect(can('doctor', 'admin:audit:read')).toBe(false);
    // admins run the platform but have no clinical access
    expect(can('admin', 'prescription:read')).toBe(false);
    expect(can('admin', 'consultation:read')).toBe(false);
    expect(can('auditor', 'admin:audit:read')).toBe(true);
    expect(can('auditor', 'admin:users:manage')).toBe(false);
    expect(permissionsOf('patient').length).toBeGreaterThan(0);
  });
  it('requires MFA for privileged roles only', () => {
    expect(mfaRequired('doctor') && mfaRequired('admin') && mfaRequired('auditor')).toBe(true);
    expect(mfaRequired('patient')).toBe(false);
  });
});

describe('password policy', () => {
  it('rejects common, email-derived, and repeated-character passwords', () => {
    expect(() => checkPasswordPolicy('password1234', 'a@b.com')).toThrow();
    expect(() => checkPasswordPolicy('xxxxxxxxxxxxxxx', 'a@b.com')).toThrow();
    expect(() => checkPasswordPolicy('Mathew-2026-secure', 'mathew@x.com')).toThrow();
    expect(() => checkPasswordPolicy('Correct-Horse-9Battery', 'mathew@x.com')).not.toThrow();
  });
});

describe('configuration validation', () => {
  const base = { ...process.env };
  it('loads valid config', () => expect(loadConfig(base).env).toBe('test'));
  it('fails fast on missing/invalid secrets', () => {
    expect(() => loadConfig({ ...base, SIGNING_KEY_B64: 'short' })).toThrow(/SIGNING_KEY_B64/);
    expect(() => loadConfig({ ...base, DATA_KEY_ACTIVE: 'nope' })).toThrow(/DATA_KEY_ACTIVE/);
    expect(() => loadConfig({ ...base, DATA_KEYS_JSON: '{"k1":"AAAA"}' })).toThrow(/32 bytes/);
  });
  it('refuses unsafe production settings', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => loadConfig(prod)).toThrow(/ENABLE_DEV_ENDPOINTS|REDIS_URL|DATABASE_SSL/);
    const almost = { ...prod, ENABLE_DEV_ENDPOINTS: 'false', REDIS_URL: 'redis://x', DATABASE_SSL: 'true', ALLOW_MOCK_PAYMENTS: 'true' };
    expect(loadConfig(almost).isProd).toBe(true);
    expect(() => loadConfig({ ...almost, ALLOW_MOCK_PAYMENTS: 'false' })).toThrow(/mock payment/);
    expect(() => loadConfig({ ...almost, CORS_ORIGINS: '*' })).toThrow(/CORS/);
  });
});

describe('validation helpers', () => {
  it('turns zod failures into 400 problems', () => {
    try {
      parse(z.strictObject({ a: z.string() }), { a: 1, extra: true });
      expect.unreachable();
    } catch (e) {
      expect((e as { status: number }).status).toBe(400);
    }
    expect(() => parse(uuid, 'nope')).toThrow();
  });
  it('cursors round-trip and reject garbage', () => {
    const s = z.object({ n: z.number() });
    expect(decodeCursor(encodeCursor({ n: 3 }), s)).toEqual({ n: 3 });
    expect(() => decodeCursor('@@@', s)).toThrow();
    expect(decodeCursor(undefined, s)).toBeUndefined();
  });
});

describe('logging redaction', () => {
  it('redacts secrets and PII from log output', () => {
    let out = '';
    const sink = new Writable({ write(chunk, _e, cb) { out += chunk.toString(); cb(); } });
    const log = createLogger({ level: 'info', service: 't', destination: sink });
    log.info({ password: 'hunter2hunter2', email: 'a@b.com', req: { headers: { authorization: 'Bearer abc' } }, nested: { token: 'tok' }, ok: 'visible' }, 'x');
    expect(out).not.toMatch(/hunter2|a@b\.com|Bearer abc|"tok"/);
    expect(out).toContain('visible');
    expect(REDACT_PATHS).toContain('refreshToken');
  });
});
