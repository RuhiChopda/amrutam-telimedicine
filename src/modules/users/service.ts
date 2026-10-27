import { z } from 'zod';
import { AAD } from '../../shared/aad';
import type { Actor } from '../../shared/context';
import type { FieldCrypto } from '../../shared/crypto';
import type { Db } from '../../shared/db';
import { badRequest, notFound } from '../../shared/errors';
import { shortText } from '../../shared/validation';
import type { AuditService } from '../audit/service';

export const profileUpdateSchema = z.strictObject({
  fullName: shortText(120).optional(),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/).nullable().optional(),
  dateOfBirth: z.string().date().nullable().optional(),
  gender: z.enum(['female', 'male', 'other', 'undisclosed']).optional(),
  locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
  ) {}

  async getMe(actor: Actor) {
    const { rows } = await this.db.query<{
      email_enc: string; mfa_enabled: boolean; full_name_enc: string; phone_enc: string | null; date_of_birth_enc: string | null;
      gender: string | null; locale: string; timezone: string;
    }>(
      `SELECT u.email_enc, u.mfa_enabled, p.full_name_enc, p.phone_enc, p.date_of_birth_enc, p.gender, p.locale, p.timezone
         FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [actor.id],
    );
    const r = rows[0];
    if (!r) throw notFound('User');
    return {
      id: actor.id,
      role: actor.role,
      mfaEnabled: r.mfa_enabled,
      email: this.crypto.decrypt(r.email_enc, AAD.userEmail(actor.id)),
      profile: {
        fullName: this.crypto.decrypt(r.full_name_enc, AAD.profileName(actor.id)),
        phone: r.phone_enc ? this.crypto.decrypt(r.phone_enc, AAD.profilePhone(actor.id)) : null,
        dateOfBirth: r.date_of_birth_enc ? this.crypto.decrypt(r.date_of_birth_enc, AAD.profileDob(actor.id)) : null,
        gender: r.gender,
        locale: r.locale,
        timezone: r.timezone,
      },
    };
  }

  async updateMe(actor: Actor, input: z.infer<typeof profileUpdateSchema>) {
    const sets: string[] = [];
    const params: unknown[] = [actor.id];
    const set = (col: string, v: unknown) => (params.push(v), sets.push(`${col} = $${params.length}`));
    if (input.fullName !== undefined) set('full_name_enc', this.crypto.encrypt(input.fullName, AAD.profileName(actor.id)));
    if (input.phone !== undefined) {
      set('phone_enc', input.phone ? this.crypto.encrypt(input.phone, AAD.profilePhone(actor.id)) : null);
      set('phone_bidx', input.phone ? this.crypto.blindIndex(input.phone) : null);
    }
    if (input.dateOfBirth !== undefined) set('date_of_birth_enc', input.dateOfBirth ? this.crypto.encrypt(input.dateOfBirth, AAD.profileDob(actor.id)) : null);
    if (input.gender !== undefined) set('gender', input.gender);
    if (input.locale !== undefined) set('locale', input.locale);
    if (input.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone });
      } catch {
        throw badRequest('INVALID_TIMEZONE', 'Unknown IANA timezone');
      }
      set('timezone', input.timezone);
    }
    if (!sets.length) throw badRequest('NO_CHANGES', 'No updatable fields supplied');
    await this.db.tx(async (tx) => {
      await tx.query(`UPDATE profiles SET ${sets.join(', ')} WHERE user_id = $1`, params);
      await this.audit.record(tx, { action: 'profile.update', entityType: 'user', entityId: actor.id, metadata: { fields: Object.keys(input) } });
    });
    return this.getMe(actor);
  }
}
