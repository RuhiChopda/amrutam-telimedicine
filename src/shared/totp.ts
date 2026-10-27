import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s) — the interoperable profile used by Google Authenticator, Authy, etc. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(buf).digest();
  const offset = (h[h.length - 1] as number) & 0x0f;
  const code =
    (((h[offset] as number) & 0x7f) << 24) |
    (((h[offset + 1] as number) & 0xff) << 16) |
    (((h[offset + 2] as number) & 0xff) << 8) |
    ((h[offset + 3] as number) & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const totpCounter = (atMs: number, period = 30) => Math.floor(atMs / 1000 / period);

export function totpNow(secretB32: string, atMs = Date.now(), digits = 6, period = 30): string {
  return hotp(base32Decode(secretB32), totpCounter(atMs, period), digits);
}

/**
 * Verifies a code within ±`window` time steps. Returns the matched counter (so the caller can reject replays of the
 * same or an earlier counter), or null when invalid.
 */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const center = totpCounter(atMs);
  let matched: number | null = null;
  for (let c = center - window; c <= center + window; c++) {
    const expected = Buffer.from(hotp(secret, c));
    // evaluate every candidate (no early exit) to keep timing independent of which step matched
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = c;
  }
  return matched;
}

export const otpauthUrl = (secretB32: string, account: string, issuer = 'Amrutam'): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}` +
  `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
