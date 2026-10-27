import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config/env';
import { addDays, addMinutes, type Clock } from '../../shared/clock';
import type { Actor, Role } from '../../shared/context';
import { dummyPasswordHash, FieldCrypto, hashPassword, randomToken, sha256, verifyPassword } from '../../shared/crypto';
import { AAD } from '../../shared/aad';
import type { Cache } from '../../shared/cache';
import type { Db, Queryable } from '../../shared/db';
import { AppError, conflict, forbidden, notFound, PG, pgCode, unauthorized, unprocessable } from '../../shared/errors';
import type { Metrics } from '../../shared/metrics';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../shared/totp';
import { emailSchema, passwordSchema, shortText } from '../../shared/validation';
import type { AuditService } from '../audit/service';
import { mfaRequired } from './rbac';
import type { TokenService } from './tokens';

export const registerSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  fullName: shortText(120),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'phone must be 8-15 digits, optional leading +').optional(),
  role: z.enum(['patient', 'doctor']).default('patient'),
  doctor: z
    .strictObject({
      licenseNumber: shortText(64),
      specialties: z.array(shortText(60)).min(1).max(8),
      languages: z.array(shortText(40)).max(10).default([]),
      city: shortText(80).optional(),
      bio: z.string().trim().max(2000).optional(),
      yearsExperience: z.number().int().min(0).max(70).optional(),
      consultationFeeMinor: z.number().int().min(0).max(10_000_000),
    })
    .optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export type LoginResult =
  | ({ mfaRequired: false; mfaEnrollmentRequired: boolean; user: UserSummary } & TokenPair)
  | { mfaRequired: true; mfaToken: string };

export interface UserSummary {
  id: string;
  role: Role;
  mfaEnabled: boolean;
}

const COMMON_PASSWORDS = new Set(
  ['password1234', 'passw0rd1234', '123456789012', 'qwertyuiop12', 'letmein12345', 'admin1234567', 'welcome12345', 'iloveyou1234'],
);

export function checkPasswordPolicy(password: string, email: string): void {
  const lower = password.toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (COMMON_PASSWORDS.has(lower) || (local.length >= 4 && lower.includes(local.toLowerCase())) || /^(.)\1+$/.test(password)) {
    throw unprocessable('WEAK_PASSWORD', 'Password is too easily guessable; avoid common words and your email name');
  }
}

interface UserRow {
  id: string;
  role: Role;
  status: string;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_pending_secret_enc: string | null;
  mfa_last_counter: number | null;
  mfa_recovery_hashes: string[];
  failed_login_count: number;
  locked_until: Date | null;
  email_enc: string;
}

const GENERIC_LOGIN_ERROR = () => unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly cache: Cache,
    private readonly clock: Clock,
    private readonly cfg: Config,
    private readonly metrics: Metrics,
  ) {}

  emailIndex(email: string): Buffer {
    return this.crypto.blindIndex(email.trim().toLowerCase());
  }

  /* ------------------------------------------------------------------ registration */
  async register(input: RegisterInput): Promise<{ id: string; role: Role; status: string }> {
    checkPasswordPolicy(input.password, input.email);
    if (input.role === 'doctor' && !input.doctor) {
      throw unprocessable('DOCTOR_DETAILS_REQUIRED', 'Doctor registration requires licence and practice details');
    }
    if (input.role === 'patient' && input.doctor) throw unprocessable('UNEXPECTED_DOCTOR_DETAILS', 'Doctor details only apply to doctors');

    const id = randomUUID();
    const passwordHash = await hashPassword(input.password);
    try {
      await this.db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO users (id, email_bidx, email_enc, password_hash, role) VALUES ($1,$2,$3,$4,$5)`,
          [id, this.emailIndex(input.email), this.crypto.encrypt(input.email, AAD.userEmail(id)), passwordHash, input.role],
        );
        await tx.query(
          `INSERT INTO profiles (user_id, full_name_enc, phone_enc, phone_bidx) VALUES ($1,$2,$3,$4)`,
          [
            id,
            this.crypto.encrypt(input.fullName, AAD.profileName(id)),
            input.phone ? this.crypto.encrypt(input.phone, AAD.profilePhone(id)) : null,
            input.phone ? this.crypto.blindIndex(input.phone) : null,
          ],
        );
        if (input.doctor) {
          const d = input.doctor;
          await tx.query(
            `INSERT INTO doctors (user_id, display_name, bio, specialties, languages, city, license_number, years_experience, consultation_fee_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [id, input.fullName, d.bio ?? null, d.specialties, d.languages, d.city ?? null, d.licenseNumber, d.yearsExperience ?? 0, d.consultationFeeMinor],
          );
        }
        await this.audit.record(tx, {
          action: 'user.register',
          actorId: id,
          actorRole: input.role,
          entityType: 'user',
          entityId: id,
          metadata: { role: input.role },
        });
      });
    } catch (err) {
      if (pgCode(err) === PG.UNIQUE_VIOLATION) {
        const constraint = (err as { constraint?: string }).constraint ?? '';
        if (constraint.includes('license')) throw conflict('LICENSE_ALREADY_REGISTERED', 'This licence number is already registered');
        throw conflict('EMAIL_ALREADY_REGISTERED', 'An account with this email already exists');
      }
      throw err;
    }
    this.metrics.authEvents.inc({ event: 'register' });
    return { id, role: input.role, status: input.role === 'doctor' ? 'PENDING_VERIFICATION' : 'ACTIVE' };
  }

  /* ------------------------------------------------------------------ login */
  async login(email: string, password: string, meta: ClientMeta): Promise<LoginResult> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id, role, status, password_hash, mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc, mfa_last_counter,
              mfa_recovery_hashes, failed_login_count, locked_until, email_enc
         FROM users WHERE email_bidx = $1`,
      [this.emailIndex(email)],
    );
    const user = rows[0];
    // Always run a full password verification (against a dummy hash if the user is unknown) to equalise timing and
    // avoid user enumeration through response latency.
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyPasswordHash()));
    const now = this.clock.now();
    const locked = !!user?.locked_until && user.locked_until > now;

    if (!user || !ok || locked || user.status !== 'ACTIVE') {
      this.metrics.authEvents.inc({ event: 'login_failed' });
      if (user && !locked && user.status === 'ACTIVE') await this.registerFailure(user.id);
      await this.audit.recordStandalone({
        action: 'auth.login',
        actorId: user?.id ?? null,
        actorRole: user?.role ?? null,
        outcome: 'FAILURE',
        entityType: 'user',
        entityId: user?.id,
        metadata: { reason: !user ? 'unknown_user' : locked ? 'locked' : user.status !== 'ACTIVE' ? 'inactive' : 'bad_password' },
      });
      throw GENERIC_LOGIN_ERROR();
    }

    if (user.mfa_enabled) {
      this.metrics.authEvents.inc({ event: 'mfa_challenge_issued' });
      return { mfaRequired: true, mfaToken: await this.tokens.signMfaChallenge(user.id) };
    }
    return this.completeLogin(user, false, meta);
  }

  private async registerFailure(userId: string): Promise<void> {
    const until = addMinutes(this.clock.now(), this.cfg.auth.lockoutMinutes);
    const { rows } = await this.db.query<{ locked_until: Date | null }>(
      `UPDATE users SET
         failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN $3 ELSE locked_until END
       WHERE id = $1 RETURNING locked_until`,
      [userId, this.cfg.auth.lockoutThreshold, until],
    );
    if (rows[0]?.locked_until && rows[0].locked_until >= until) {
      this.metrics.authEvents.inc({ event: 'account_locked' });
      await this.audit.recordStandalone({ action: 'auth.account_locked', actorId: userId, entityType: 'user', entityId: userId, outcome: 'DENIED' });
    }
  }

  private async completeLogin(user: UserRow, mfaVerified: boolean, meta: ClientMeta): Promise<LoginResult> {
    await this.db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1', [
      user.id,
      this.clock.now(),
    ]);
    const pair = await this.issueSession(this.db, { id: user.id, role: user.role }, mfaVerified, meta, randomUUID());
    await this.audit.recordStandalone({
      action: 'auth.login',
      actorId: user.id,
      actorRole: user.role,
      entityType: 'user',
      entityId: user.id,
      metadata: { mfa: mfaVerified },
    });
    this.metrics.authEvents.inc({ event: 'login_success' });
    return {
      mfaRequired: false,
      mfaEnrollmentRequired: mfaRequired(user.role) && !mfaVerified,
      user: { id: user.id, role: user.role, mfaEnabled: user.mfa_enabled },
      ...pair,
    };
  }

  private async issueSession(
    q: Queryable,
    user: { id: string; role: Role },
    mfaVerified: boolean,
    meta: ClientMeta,
    familyId: string,
  ): Promise<TokenPair> {
    const refreshToken = randomToken(32);
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO sessions (user_id, family_id, token_hash, mfa_verified, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        user.id,
        familyId,
        sha256(refreshToken),
        mfaVerified,
        meta.ip && /^[0-9a-fA-F:.]+$/.test(meta.ip) ? meta.ip : null,
        meta.userAgent?.slice(0, 300) ?? null,
        addDays(this.clock.now(), this.cfg.jwt.refreshTtlDays),
      ],
    );
    const accessToken = await this.tokens.signAccess({
      sub: user.id,
      role: user.role,
      sid: (rows[0] as { id: string }).id,
      amr: mfaVerified ? ['pwd', 'otp'] : ['pwd'],
    });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: this.tokens.accessTtlSeconds };
  }

  /* ------------------------------------------------------------------ MFA */
  async completeMfaLogin(input: { mfaToken: string; code?: string; recoveryCode?: string }, meta: ClientMeta): Promise<LoginResult> {
    const { sub } = await this.tokens.verifyMfaChallenge(input.mfaToken);
    const { rows } = await this.db.query<UserRow>(
      `SELECT id, role, status, password_hash, mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc, mfa_last_counter,
              mfa_recovery_hashes, failed_login_count, locked_until, email_enc FROM users WHERE id = $1`,
      [sub],
    );
    const user = rows[0];
    const now = this.clock.now();
    if (!user || user.status !== 'ACTIVE' || !user.mfa_enabled || !user.mfa_secret_enc || (user.locked_until && user.locked_until > now)) {
      throw GENERIC_LOGIN_ERROR();
    }

    let verified = false;
    if (input.code) {
      const secret = this.crypto.decrypt(user.mfa_secret_enc, AAD.userMfaSecret(user.id));
      const counter = verifyTotp(secret, input.code, now.getTime());
      if (counter !== null) {
        // Replay protection: a counter may be accepted once. Compare-and-set so concurrent submissions cannot both win.
        const upd = await this.db.query(
          'UPDATE users SET mfa_last_counter = $2 WHERE id = $1 AND (mfa_last_counter IS NULL OR mfa_last_counter < $2)',
          [user.id, counter],
        );
        verified = upd.rowCount === 1;
      }
    } else if (input.recoveryCode) {
      const hash = sha256(input.recoveryCode.trim().toUpperCase()).toString('hex');
      const upd = await this.db.query(
        'UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $2) WHERE id = $1 AND $2 = ANY(mfa_recovery_hashes)',
        [user.id, hash],
      );
      verified = upd.rowCount === 1;
      if (verified) {
        await this.audit.recordStandalone({ action: 'auth.mfa_recovery_code_used', actorId: user.id, actorRole: user.role, entityType: 'user', entityId: user.id });
      }
    }

    if (!verified) {
      this.metrics.authEvents.inc({ event: 'mfa_failed' });
      await this.registerFailure(user.id);
      await this.audit.recordStandalone({ action: 'auth.mfa', actorId: user.id, actorRole: user.role, outcome: 'FAILURE', entityType: 'user', entityId: user.id });
      throw unauthorized('Invalid verification code', 'INVALID_MFA_CODE');
    }
    return this.completeLogin(user, true, meta);
  }

  async startMfaEnrollment(actor: Actor): Promise<{ secret: string; otpauthUrl: string }> {
    const { rows } = await this.db.query<{ mfa_enabled: boolean; email_enc: string }>(
      'SELECT mfa_enabled, email_enc FROM users WHERE id = $1',
      [actor.id],
    );
    const u = rows[0];
    if (!u) throw notFound('User');
    if (u.mfa_enabled) throw conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled for this account');
    const secret = generateTotpSecret();
    await this.db.query('UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1', [
      actor.id,
      this.crypto.encrypt(secret, AAD.userMfaPending(actor.id)),
    ]);
    const email = this.crypto.decrypt(u.email_enc, AAD.userEmail(actor.id));
    return { secret, otpauthUrl: otpauthUrl(secret, email) };
  }

  /** Confirms enrolment with a first valid code, returns one-time recovery codes and a fresh MFA-verified session. */
  async activateMfa(actor: Actor, code: string, meta: ClientMeta): Promise<{ recoveryCodes: string[] } & TokenPair> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT id, role, status, password_hash, mfa_enabled, mfa_secret_enc, mfa_pending_secret_enc, mfa_last_counter,
              mfa_recovery_hashes, failed_login_count, locked_until, email_enc FROM users WHERE id = $1`,
      [actor.id],
    );
    const u = rows[0];
    if (!u || !u.mfa_pending_secret_enc) throw conflict('MFA_NOT_STARTED', 'Start MFA enrolment first');
    const secret = this.crypto.decrypt(u.mfa_pending_secret_enc, AAD.userMfaPending(u.id));
    const counter = verifyTotp(secret, code, this.clock.now().getTime());
    if (counter === null) throw unauthorized('Invalid verification code', 'INVALID_MFA_CODE');

    const recoveryCodes = Array.from({ length: 10 }, () => {
      const raw = randomBytes(8).toString('hex').toUpperCase();
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`;
    });
    const pair = await this.db.tx(async (tx) => {
      await tx.query(
        `UPDATE users SET mfa_enabled = true, mfa_secret_enc = $2, mfa_pending_secret_enc = NULL, mfa_last_counter = $3,
                          mfa_recovery_hashes = $4 WHERE id = $1`,
        [u.id, this.crypto.encrypt(secret, AAD.userMfaSecret(u.id)), counter, recoveryCodes.map((c) => sha256(c).toString('hex'))],
      );
      // Replace the current (password-only) session with an MFA-verified one.
      await tx.query(`UPDATE sessions SET status = 'REVOKED' WHERE id = $1`, [actor.sessionId]);
      await this.audit.record(tx, { action: 'auth.mfa_enabled', entityType: 'user', entityId: u.id });
      return this.issueSession(tx, { id: u.id, role: u.role }, true, meta, randomUUID());
    });
    await this.denySession(actor.sessionId);
    return { recoveryCodes, ...pair };
  }

  /* ------------------------------------------------------------------ refresh / logout */
  async refresh(refreshToken: string, meta: ClientMeta): Promise<TokenPair> {
    type Outcome = { kind: 'ok'; pair: TokenPair } | { kind: 'reuse'; userId: string; sids: string[] } | { kind: 'invalid' };
    const outcome: Outcome = await this.db.tx(async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        user_id: string;
        family_id: string;
        status: string;
        mfa_verified: boolean;
        expires_at: Date;
        role: Role;
        user_status: string;
      }>(
        `SELECT s.id, s.user_id, s.family_id, s.status, s.mfa_verified, s.expires_at, u.role, u.status AS user_status
           FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 FOR UPDATE OF s`,
        [sha256(refreshToken)],
      );
      const s = rows[0];
      if (!s) return { kind: 'invalid' };
      if (s.status === 'ROTATED') {
        // Token reuse => likely theft. Revoke the entire family (the legitimate holder must log in again).
        const revoked = await tx.query<{ id: string }>(
          `UPDATE sessions SET status = 'REVOKED' WHERE family_id = $1 AND status <> 'REVOKED' RETURNING id`,
          [s.family_id],
        );
        await this.audit.record(tx, {
          action: 'auth.refresh_reuse_detected',
          actorId: s.user_id,
          actorRole: s.role,
          outcome: 'DENIED',
          entityType: 'session',
          entityId: s.id,
          metadata: { familyId: s.family_id },
        });
        return { kind: 'reuse', userId: s.user_id, sids: revoked.rows.map((r) => r.id) };
      }
      if (s.status !== 'ACTIVE' || s.expires_at < this.clock.now() || s.user_status !== 'ACTIVE') return { kind: 'invalid' };
      await tx.query(`UPDATE sessions SET status = 'ROTATED', rotated_at = $2 WHERE id = $1`, [s.id, this.clock.now()]);
      const pair = await this.issueSession(tx, { id: s.user_id, role: s.role }, s.mfa_verified, meta, s.family_id);
      return { kind: 'ok', pair };
    });
    if (outcome.kind === 'reuse') {
      this.metrics.authEvents.inc({ event: 'refresh_reuse_detected' });
      await Promise.all(outcome.sids.map((sid) => this.denySession(sid)));
      throw unauthorized('Refresh token is no longer valid', 'INVALID_REFRESH_TOKEN');
    }
    if (outcome.kind === 'invalid') throw unauthorized('Refresh token is invalid or expired', 'INVALID_REFRESH_TOKEN');
    return outcome.pair;
  }

  async logout(actor: Actor): Promise<void> {
    await this.db.query(`UPDATE sessions SET status = 'REVOKED' WHERE id = $1`, [actor.sessionId]);
    await this.denySession(actor.sessionId);
    await this.audit.recordStandalone({ action: 'auth.logout', entityType: 'session', entityId: actor.sessionId });
  }

  async changePassword(actor: Actor, current: string, next: string): Promise<void> {
    const { rows } = await this.db.query<{ password_hash: string; email_enc: string }>(
      'SELECT password_hash, email_enc FROM users WHERE id = $1',
      [actor.id],
    );
    const u = rows[0];
    if (!u || !(await verifyPassword(current, u.password_hash))) throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
    checkPasswordPolicy(next, this.crypto.decrypt(u.email_enc, AAD.userEmail(actor.id)));
    const hash = await hashPassword(next);
    const sids = await this.db.tx(async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [actor.id, hash]);
      const r = await tx.query<{ id: string }>(
        `UPDATE sessions SET status = 'REVOKED' WHERE user_id = $1 AND status <> 'REVOKED' RETURNING id`,
        [actor.id],
      );
      await this.audit.record(tx, { action: 'auth.password_changed', entityType: 'user', entityId: actor.id });
      return r.rows.map((x) => x.id);
    });
    await Promise.all(sids.map((s) => this.denySession(s)));
  }

  /** Revokes all sessions of a user and invalidates already-issued access tokens (suspension, MFA reset). */
  async revokeAllSessions(q: Queryable, userId: string): Promise<string[]> {
    const r = await q.query<{ id: string }>(
      `UPDATE sessions SET status = 'REVOKED' WHERE user_id = $1 AND status <> 'REVOKED' RETURNING id`,
      [userId],
    );
    return r.rows.map((x) => x.id);
  }

  async denySession(sid: string): Promise<void> {
    await this.cache.set(`revoked:sid:${sid}`, 1, this.tokens.accessTtlSeconds + 30);
  }

  async denyUser(userId: string): Promise<void> {
    await this.cache.set(`revoked:user:${userId}`, Math.floor(this.clock.now().getTime() / 1000), this.tokens.accessTtlSeconds + 30);
  }

  /** Called on every authenticated request. Cheap (cache only); fails open if the cache is down (bounded by token TTL). */
  async isRevoked(sid: string, userId: string, iat: number): Promise<boolean> {
    const [s, u] = await Promise.all([this.cache.get<number>(`revoked:sid:${sid}`), this.cache.get<number>(`revoked:user:${userId}`)]);
    return s !== undefined || (u !== undefined && iat <= u);
  }

  async verifyAccessToken(token: string): Promise<Actor> {
    const claims = await this.tokens.verifyAccess(token);
    if (await this.isRevoked(claims.sid, claims.sub, claims.iat)) throw unauthorized('Session has been revoked', 'SESSION_REVOKED');
    return { id: claims.sub, role: claims.role, sessionId: claims.sid, amr: claims.amr };
  }

  async assertMfaSatisfied(actor: Actor): Promise<void> {
    if (mfaRequired(actor.role) && !actor.amr.includes('otp')) {
      throw new AppError(403, 'MFA_REQUIRED', 'Multi-factor authentication is required for this role', {
        hint: 'POST /v1/auth/mfa/enroll then /v1/auth/mfa/activate, or complete the MFA challenge at login',
      });
    }
  }

  /** Admin-initiated MFA reset for a user who lost their device and recovery codes. */
  async resetMfa(adminActor: Actor, userId: string): Promise<void> {
    if (adminActor.id === userId) throw forbidden('Administrators cannot reset their own MFA', 'SELF_MFA_RESET');
    const sids = await this.db.tx(async (tx) => {
      const r = await tx.query(
        `UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_recovery_hashes = '{}', mfa_last_counter = NULL WHERE id = $1`,
        [userId],
      );
      if (r.rowCount === 0) throw notFound('User');
      const s = await this.revokeAllSessions(tx, userId);
      await this.audit.record(tx, { action: 'admin.mfa_reset', entityType: 'user', entityId: userId });
      return s;
    });
    await Promise.all(sids.map((s) => this.denySession(s)));
    await this.denyUser(userId);
  }

  async setUserStatus(adminActor: Actor, userId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<void> {
    if (adminActor.id === userId) throw forbidden('Administrators cannot change their own status', 'SELF_STATUS_CHANGE');
    const sids = await this.db.tx(async (tx) => {
      const r = await tx.query('UPDATE users SET status = $2 WHERE id = $1 AND status <> $2', [userId, status]);
      if (r.rowCount === 0) {
        const exists = await tx.query('SELECT 1 FROM users WHERE id = $1', [userId]);
        if (exists.rowCount === 0) throw notFound('User');
      }
      const s = status === 'SUSPENDED' ? await this.revokeAllSessions(tx, userId) : [];
      await this.audit.record(tx, { action: `admin.user_${status.toLowerCase()}`, entityType: 'user', entityId: userId });
      return s;
    });
    if (status === 'SUSPENDED') {
      await Promise.all(sids.map((s) => this.denySession(s)));
      await this.denyUser(userId);
    }
  }
}
