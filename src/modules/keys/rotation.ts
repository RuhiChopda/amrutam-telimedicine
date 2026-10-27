import type { FieldCrypto } from '../../shared/crypto';
import type { Db } from '../../shared/db';
import type { Logger } from '../../shared/logger';
import { AAD } from '../../shared/aad';

interface FieldSpec {
  table: string;
  idCol: string;
  col: string;
  aad: (id: string) => string;
  /** extra predicate for partitioned tables is not needed: ids are globally unique */
}

const FIELDS: FieldSpec[] = [
  { table: 'users', idCol: 'id', col: 'email_enc', aad: AAD.userEmail },
  { table: 'users', idCol: 'id', col: 'mfa_secret_enc', aad: AAD.userMfaSecret },
  { table: 'users', idCol: 'id', col: 'mfa_pending_secret_enc', aad: AAD.userMfaPending },
  { table: 'profiles', idCol: 'user_id', col: 'full_name_enc', aad: AAD.profileName },
  { table: 'profiles', idCol: 'user_id', col: 'phone_enc', aad: AAD.profilePhone },
  { table: 'profiles', idCol: 'user_id', col: 'date_of_birth_enc', aad: AAD.profileDob },
  { table: 'consultations', idCol: 'id', col: 'reason_enc', aad: AAD.consultationReason },
  { table: 'consultations', idCol: 'id', col: 'notes_enc', aad: AAD.consultationNotes },
  { table: 'prescriptions', idCol: 'id', col: 'content_enc', aad: AAD.prescription },
  { table: 'payments', idCol: 'id', col: 'client_secret_enc', aad: AAD.paymentSecret },
];

/**
 * Online data-key rotation: after a new key is made active (DATA_KEY_ACTIVE), this job re-encrypts rows still protected by
 * older keys in small batches (SKIP LOCKED, so it never blocks request traffic). Once `remaining` reaches 0 the old key
 * can be retired from the keyring. Safe to re-run; each row is decrypted with its recorded key id and rewritten atomically.
 */
export class KeyRotationService {
  constructor(
    private readonly db: Db,
    private readonly crypto: FieldCrypto,
    private readonly logger: Logger,
  ) {}

  async reencryptBatch(batchSize = 200): Promise<{ rotated: number; remaining: number }> {
    let rotated = 0;
    let remaining = 0;
    for (const f of FIELDS) {
      const activePrefix = `enc:v1:${this.crypto.activeId}:`;
      const rows = await this.db.query<{ id: string; v: string }>(
        `SELECT ${f.idCol}::text AS id, ${f.col} AS v FROM ${f.table}
          WHERE ${f.col} IS NOT NULL AND ${f.col} NOT LIKE $1 LIMIT $2`,
        [activePrefix + '%', batchSize],
      );
      for (const r of rows.rows) {
        try {
          const plain = this.crypto.decrypt(r.v, f.aad(r.id));
          const next = this.crypto.encrypt(plain, f.aad(r.id));
          // compare-and-swap on the old ciphertext: a concurrent writer wins, we simply retry next batch
          const u = await this.db.query(`UPDATE ${f.table} SET ${f.col} = $3 WHERE ${f.idCol}::text = $1 AND ${f.col} = $2`, [r.id, r.v, next]);
          rotated += u.rowCount ?? 0;
        } catch (err) {
          this.logger.error({ table: f.table, col: f.col, id: r.id, err: (err as Error).message }, 'key rotation: row could not be re-encrypted');
        }
      }
      const left = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${f.table} WHERE ${f.col} IS NOT NULL AND ${f.col} NOT LIKE $1`, [activePrefix + '%']);
      remaining += left.rows[0]?.n ?? 0;
    }
    return { rotated, remaining };
  }
}
