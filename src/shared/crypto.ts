import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';

/* ------------------------------------------------------------------------------------------------
 * Field-level encryption (AES-256-GCM) with a versioned keyring.
 *
 * Wire format:  enc:v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 *
 * - Random 96-bit IV per encryption (NIST SP 800-38D); never reused with the same key in practice.
 * - AAD binds the ciphertext to its location ("table.column:rowId") so a ciphertext copied to another row/column
 *   fails authentication (prevents swapping attacks by a DB-level attacker).
 * - keyId makes rotation online: new writes use the active key, old rows stay readable until re-encrypted by the
 *   background rotation job.
 * ---------------------------------------------------------------------------------------------- */
const PREFIX = 'enc:v1:';

export class FieldCrypto {
  constructor(
    private readonly keys: Record<string, Buffer>,
    private readonly activeKeyId: string,
    private readonly blindKey: Buffer,
  ) {
    if (!keys[activeKeyId]) throw new Error(`Active data key "${activeKeyId}" missing from keyring`);
  }

  get activeId(): string {
    return this.activeKeyId;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys[this.activeKeyId] as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${this.activeKeyId}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
  }

  decrypt(payload: string, aad: string): string {
    if (!payload.startsWith(PREFIX)) throw new Error('Not an encrypted field');
    const [keyId, iv, tag, ct] = payload.slice(PREFIX.length).split(':');
    const key = keyId ? this.keys[keyId] : undefined;
    if (!key || !iv || !tag || !ct) throw new Error('Unknown key id or malformed ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown, aad: string): string {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(payload: string, aad: string): T {
    return JSON.parse(this.decrypt(payload, aad)) as T;
  }

  /** Which key id encrypted this payload (null if it is not an encrypted field). */
  keyIdOf(payload: string): string | null {
    if (!payload.startsWith(PREFIX)) return null;
    return payload.slice(PREFIX.length).split(':')[0] ?? null;
  }

  needsRotation(payload: string): boolean {
    const id = this.keyIdOf(payload);
    return id !== null && id !== this.activeKeyId;
  }

  /** Deterministic keyed hash for equality lookups on encrypted columns (emails, phones). */
  blindIndex(value: string): Buffer {
    return createHmac('sha256', this.blindKey).update(value, 'utf8').digest();
  }
}

/* ------------------------------------------------------------------------------------------------
 * Password hashing: scrypt (memory-hard, built into Node; no native addon to patch).
 * Format: scrypt$N$r$p$salt$hash
 * ---------------------------------------------------------------------------------------------- */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 };

const scrypt = (password: string, salt: Buffer, N: number, r: number, p: number, keylen: number, maxmem: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

export async function hashPassword(password: string, params = SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, params.N, params.r, params.p, params.keylen, params.maxmem);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), +n, +r, +p, expected.length, SCRYPT.maxmem);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A valid hash of a random password, used to equalise login timing when the account does not exist. */
let dummyHashPromise: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHashPromise ??= hashPassword(randomBytes(16).toString('hex')));

/* ------------------------------------------------------------------------------------------------
 * Misc primitives
 * ---------------------------------------------------------------------------------------------- */
export const sha256 = (data: string | Buffer): Buffer => createHash('sha256').update(data).digest();
export const hmacSha256 = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JSON with sorted keys: stable input for hashing/signing (jsonb reorders keys). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Signs artefacts (prescriptions). HMAC today; swap for a KMS asymmetric signer without touching callers. */
export interface Signer {
  sign(message: string): string;
  verify(message: string, signature: string): boolean;
}

export class HmacSigner implements Signer {
  constructor(private readonly key: Buffer) {}
  sign(message: string): string {
    return `hmac-sha256:${hmacSha256(this.key, message).toString('base64url')}`;
  }
  verify(message: string, signature: string): boolean {
    return safeEqual(this.sign(message), signature);
  }
}
