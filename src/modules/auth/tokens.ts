import { randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload, type KeyLike } from 'jose';
import type { Config } from '../../config/env';
import type { Role } from '../../shared/context';
import { unauthorized } from '../../shared/errors';

type VerifyKey = KeyLike | Uint8Array;

export interface AccessClaims {
  sub: string;
  role: Role;
  sid: string;
  amr: string[];
  iat: number;
  exp: number;
}

const ALG = 'ES256';

/**
 * Asymmetric JWTs (ES256): other services can verify tokens with the public key without being able to mint them.
 * Rotation: new tokens carry the active `kid`; previous public keys stay in the verify set until their tokens expire.
 */
export class TokenService {
  private constructor(
    private readonly cfg: Config['jwt'],
    private readonly privateKey: KeyLike,
    private readonly verifyKeys: Record<string, VerifyKey>,
  ) {}

  static async create(cfg: Config['jwt']): Promise<TokenService> {
    const privateKey = await importPKCS8(cfg.privateKeyPem, ALG);
    const verifyKeys: Record<string, VerifyKey> = { [cfg.keyId]: await importSPKI(cfg.publicKeyPem, ALG) };
    for (const [kid, pem] of Object.entries(cfg.previousPublicKeys)) verifyKeys[kid] = await importSPKI(pem, ALG);
    return new TokenService(cfg, privateKey, verifyKeys);
  }

  get accessTtlSeconds(): number {
    return this.cfg.accessTtlSeconds;
  }

  private sign(use: 'access' | 'mfa', claims: JWTPayload, ttlSeconds: number): Promise<string> {
    return new SignJWT({ ...claims, use })
      .setProtectedHeader({ alg: ALG, kid: this.cfg.keyId, typ: 'JWT' })
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.audience)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.privateKey);
  }

  signAccess(p: { sub: string; role: Role; sid: string; amr: string[] }): Promise<string> {
    return this.sign('access', { sub: p.sub, role: p.role, sid: p.sid, amr: p.amr }, this.cfg.accessTtlSeconds);
  }

  signMfaChallenge(userId: string): Promise<string> {
    return this.sign('mfa', { sub: userId }, 300);
  }

  private async verify(token: string, use: 'access' | 'mfa'): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(
        token,
        async (header) => {
          const key = header.kid ? this.verifyKeys[header.kid] : undefined;
          if (!key) throw new Error('unknown kid');
          return key;
        },
        { algorithms: [ALG], issuer: this.cfg.issuer, audience: this.cfg.audience, clockTolerance: 5 },
      );
      if (payload.use !== use) throw new Error('wrong token use');
      return payload;
    } catch {
      throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    }
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const p = await this.verify(token, 'access');
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.role !== 'string' || !Array.isArray(p.amr)) {
      throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    }
    return { sub: p.sub, role: p.role as Role, sid: p.sid, amr: p.amr as string[], iat: p.iat as number, exp: p.exp as number };
  }

  async verifyMfaChallenge(token: string): Promise<{ sub: string }> {
    const p = await this.verify(token, 'mfa');
    if (typeof p.sub !== 'string') throw unauthorized('Invalid or expired token', 'INVALID_TOKEN');
    return { sub: p.sub };
  }
}
