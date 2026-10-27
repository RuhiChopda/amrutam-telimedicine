import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, totpNow, verifyTotp } from '../../src/shared/totp';

// RFC 6238 Appendix B (SHA-1, secret "12345678901234567890"), truncated to 6 digits.
const secret = Buffer.from('12345678901234567890');
const B32 = base32Encode(secret);

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    const vectors: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
    for (const [t, code] of vectors) expect(totpNow(B32, t * 1000)).toBe(code);
  });
  it('base32 round-trips', () => expect(base32Decode(B32).equals(secret)).toBe(true));
  it('accepts ±1 step and returns the matched counter; rejects further drift and malformed input', () => {
    const now = 1_700_000_000_000;
    const counter = Math.floor(now / 30000);
    expect(verifyTotp(B32, hotp(secret, counter), now)).toBe(counter);
    expect(verifyTotp(B32, hotp(secret, counter - 1), now)).toBe(counter - 1);
    expect(verifyTotp(B32, hotp(secret, counter + 1), now)).toBe(counter + 1);
    expect(verifyTotp(B32, hotp(secret, counter + 2), now)).toBeNull();
    expect(verifyTotp(B32, '12345', now)).toBeNull();
    expect(verifyTotp(B32, 'abcdef', now)).toBeNull();
  });
});
