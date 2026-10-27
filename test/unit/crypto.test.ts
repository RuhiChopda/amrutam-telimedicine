import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FieldCrypto, HmacSigner, hashPassword, stableStringify, verifyPassword } from '../../src/shared/crypto';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const mk = (active = 'k1') => new FieldCrypto({ k1, k2 }, active, randomBytes(32));

describe('FieldCrypto (AES-256-GCM)', () => {
  it('round-trips and never repeats ciphertext for the same plaintext (random IV)', () => {
    const c = mk();
    const a = c.encrypt('hello', 'users.email:1');
    const b = c.encrypt('hello', 'users.email:1');
    expect(a).not.toEqual(b);
    expect(c.decrypt(a, 'users.email:1')).toBe('hello');
  });

  it('rejects a ciphertext moved to another row/column (AAD binding)', () => {
    const c = mk();
    const ct = c.encrypt('secret', 'users.email:1');
    expect(() => c.decrypt(ct, 'users.email:2')).toThrow();
    expect(() => c.decrypt(ct, 'profiles.phone:1')).toThrow();
  });

  it('detects tampering with any ciphertext byte', () => {
    const c = mk();
    const ct = c.encrypt('secret', 'a');
    const parts = ct.split(':');
    const raw = Buffer.from(parts[5] as string, 'base64url');
    raw[0] = (raw[0] as number) ^ 1;
    parts[5] = raw.toString('base64url');
    expect(() => c.decrypt(parts.join(':'), 'a')).toThrow();
  });

  it('supports key rotation: old ciphertext stays readable, new writes use the active key', () => {
    const old = mk('k1').encrypt('data', 'x');
    const rotated = mk('k2');
    expect(rotated.decrypt(old, 'x')).toBe('data');
    expect(rotated.needsRotation(old)).toBe(true);
    const fresh = rotated.encrypt('data', 'x');
    expect(rotated.keyIdOf(fresh)).toBe('k2');
    expect(rotated.needsRotation(fresh)).toBe(false);
  });

  it('blind index is deterministic per key and different across keys', () => {
    const a = new FieldCrypto({ k1 }, 'k1', Buffer.alloc(32, 1));
    const b = new FieldCrypto({ k1 }, 'k1', Buffer.alloc(32, 2));
    expect(a.blindIndex('x@y.com').equals(a.blindIndex('x@y.com'))).toBe(true);
    expect(a.blindIndex('x@y.com').equals(b.blindIndex('x@y.com'))).toBe(false);
  });

  it('refuses to start without the active key', () => {
    expect(() => new FieldCrypto({ k1 }, 'missing', Buffer.alloc(32))).toThrow();
  });
});

describe('password hashing (scrypt)', () => {
  it('verifies the right password and rejects others; salts are unique', async () => {
    const h1 = await hashPassword('Correct-Horse-9Battery');
    const h2 = await hashPassword('Correct-Horse-9Battery');
    expect(h1).not.toEqual(h2);
    expect(await verifyPassword('Correct-Horse-9Battery', h1)).toBe(true);
    expect(await verifyPassword('correct-horse-9battery', h1)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('stableStringify / HmacSigner', () => {
  it('is independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(stableStringify({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
  it('signs and verifies, failing on any change', () => {
    const s = new HmacSigner(randomBytes(32));
    const sig = s.sign('msg');
    expect(s.verify('msg', sig)).toBe(true);
    expect(s.verify('msg2', sig)).toBe(false);
    expect(new HmacSigner(randomBytes(32)).verify('msg', sig)).toBe(false);
  });
});
