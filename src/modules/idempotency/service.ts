import { conflict, pgCode, PG, unprocessable } from '../../shared/errors';
import { sha256, stableStringify } from '../../shared/crypto';
import type { Db, Tx } from '../../shared/db';
import type { Metrics } from '../../shared/metrics';

export interface IdempotentResult<T = unknown> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotency for unsafe writes (Idempotency-Key header).
 *
 * The key row is inserted INSIDE the same DB transaction as the business effect and the stored response is written
 * before COMMIT. Consequences:
 *   - effect and recorded response are atomic: a crash can never leave "done but unrecorded" (client retry is safe)
 *     nor "recorded but not done";
 *   - concurrent duplicates serialize on the primary-key insert: the loser blocks until the winner commits, then
 *     replays the stored response (exactly-once effect, no distributed lock needed);
 *   - same key + different payload is rejected (422) instead of silently returning an unrelated response;
 *   - a handler that throws rolls everything back, including the key, so failed attempts can be retried.
 * Scope is (user_id, key): one user cannot collide with or probe another user's keys.
 */
export class IdempotencyService {
  constructor(
    private readonly db: Db,
    private readonly metrics?: Metrics,
  ) {}

  async run<T>(
    args: { userId: string; key: string; method: string; path: string; body: unknown },
    handler: (tx: Tx) => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const requestHash = sha256(`${args.method}\n${args.path}\n${stableStringify(args.body ?? null)}`);
    try {
      return await this.db.tx(async (tx) => {
        await tx.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at < now()', [
          args.userId,
          args.key,
        ]);
        const inserted = await tx.query(
          `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, key) DO NOTHING RETURNING 1`,
          [args.userId, args.key, requestHash],
        );
        if (inserted.rowCount === 0) {
          const { rows } = await tx.query<{ request_hash: Buffer; response_status: number; response_body: T }>(
            'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
            [args.userId, args.key],
          );
          const existing = rows[0];
          if (!existing) throw conflict('IDEMPOTENCY_CONFLICT', 'Concurrent request with the same Idempotency-Key; retry');
          if (!existing.request_hash.equals(requestHash)) {
            throw unprocessable(
              'IDEMPOTENCY_KEY_REUSED',
              'This Idempotency-Key was already used with a different request payload',
            );
          }
          this.metrics?.idempotentReplays.inc();
          return { status: existing.response_status, body: existing.response_body, replayed: true };
        }
        const out = await handler(tx);
        await tx.query('UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2', [
          args.userId,
          args.key,
          out.status,
          JSON.stringify(out.body),
        ]);
        return { ...out, replayed: false };
      });
    } catch (err) {
      if (pgCode(err) === PG.LOCK_NOT_AVAILABLE) {
        throw conflict('IDEMPOTENT_REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
      }
      throw err;
    }
  }
}
