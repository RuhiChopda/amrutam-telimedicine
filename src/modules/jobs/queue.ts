import type { Clock } from '../../shared/clock';
import type { Db, Queryable } from '../../shared/db';
import { PermanentJobError } from '../../shared/errors';
import type { Metrics } from '../../shared/metrics';

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  delaySeconds?: number;
  /** Enqueue is a no-op if a job with this key already exists (exactly-once enqueue for sagas/webhooks). */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Equal-jitter exponential backoff: half deterministic + half random, guaranteeing a minimum spacing between retries. */
export function jobRetryDelayMs(attempt: number, random: () => number = Math.random, baseMs = 2000, capMs = 300_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Durable queue + transactional outbox in Postgres.
 *
 *  enqueue(tx, …)  — called inside the business transaction: the job exists iff the business change committed
 *                    (no dual-write problem, no lost messages).
 *  claim()         — FOR UPDATE SKIP LOCKED: any number of workers pull disjoint batches without blocking each other.
 *  lease           — a RUNNING job whose lease expires (worker crash) is reclaimed and retried.
 *  retry           — equal-jitter exponential backoff, then DEAD after max_attempts (dead-letter, alertable, requeueable).
 * Delivery is at-least-once, so every handler is idempotent.
 */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly metrics?: Metrics,
  ) {}

  async enqueue(q: Queryable, type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<void> {
    const runAt = new Date(this.clock.now().getTime() + (opts.delaySeconds ?? 0) * 1000);
    await q.query(
      `INSERT INTO jobs (type, payload, dedupe_key, run_at, max_attempts) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [type, JSON.stringify(payload), opts.dedupeKey ?? null, runAt, opts.maxAttempts ?? 8],
    );
  }

  async claim(workerId: string, limit: number, leaseSeconds: number): Promise<Job[]> {
    const now = this.clock.now();
    const { rows } = await this.db.query<Job>(
      `UPDATE jobs SET status = 'RUNNING', locked_by = $1, locked_until = $2, attempts = attempts + 1, updated_at = now()
        WHERE id IN (SELECT id FROM jobs WHERE status = 'PENDING' AND run_at <= $3
                      ORDER BY run_at LIMIT $4 FOR UPDATE SKIP LOCKED)
        RETURNING id, type, payload, attempts, max_attempts`,
      [workerId, new Date(now.getTime() + leaseSeconds * 1000), now, limit],
    );
    return rows;
  }

  async complete(id: string): Promise<void> {
    await this.db.query(
      `UPDATE jobs SET status = 'SUCCEEDED', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /** Records a failure; schedules a retry or dead-letters. Returns the resulting status. */
  async fail(job: Job, err: unknown): Promise<'PENDING' | 'DEAD'> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    const permanent = err instanceof PermanentJobError;
    if (permanent || job.attempts >= job.max_attempts) {
      await this.db.query(
        `UPDATE jobs SET status = 'DEAD', finished_at = now(), locked_by = NULL, locked_until = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
        [job.id, message],
      );
      return 'DEAD';
    }
    const runAt = new Date(this.clock.now().getTime() + jobRetryDelayMs(job.attempts));
    await this.db.query(
      `UPDATE jobs SET status = 'PENDING', run_at = $2, locked_by = NULL, locked_until = NULL, last_error = $3, updated_at = now() WHERE id = $1`,
      [job.id, runAt, message],
    );
    return 'PENDING';
  }

  /** Returns jobs whose worker died (lease expired) to the queue, or dead-letters them if out of attempts. */
  async reclaimExpired(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE jobs SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
              finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
              last_error = coalesce(last_error, 'lease expired (worker crashed or stalled)'),
              locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE status = 'RUNNING' AND locked_until < $1`,
      [this.clock.now()],
    );
    return rowCount ?? 0;
  }

  async requeueDead(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE jobs SET status = 'PENDING', attempts = 0, run_at = now(), finished_at = NULL, updated_at = now()
        WHERE id = $1 AND status = 'DEAD'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async listDead(limit = 50) {
    const { rows } = await this.db.query(
      `SELECT id, type, attempts, last_error, finished_at, payload FROM jobs WHERE status = 'DEAD' ORDER BY finished_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async deleteFinished(olderThan: Date): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM jobs WHERE status = 'SUCCEEDED' AND finished_at < $1`, [olderThan]);
    return rowCount ?? 0;
  }

  /** Updates queue gauges (called by the worker on an interval). */
  async publishStats(): Promise<void> {
    if (!this.metrics) return;
    const { rows } = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('PENDING','RUNNING','DEAD') GROUP BY status`,
    );
    for (const s of ['PENDING', 'RUNNING', 'DEAD']) {
      this.metrics.jobsQueueDepth.set({ status: s.toLowerCase() }, rows.find((r) => r.status === s)?.n ?? 0);
    }
    const age = await this.db.query<{ age: number | null }>(
      `SELECT extract(epoch FROM (now() - min(run_at)))::float8 AS age FROM jobs WHERE status = 'PENDING' AND run_at <= now()`,
    );
    this.metrics.jobOldestPendingAge.set(Math.max(0, age.rows[0]?.age ?? 0));
  }
}
