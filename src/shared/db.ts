import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import type { Config } from '../config/env';
import { PG, pgCode } from './errors';
import type { Logger } from './logger';
import type { Metrics } from './metrics';
import { backoffDelayMs } from './retry';

// NUMERIC -> number (ratings), INT8 -> number (counts/sums; guarded against precision loss).
types.setTypeParser(1700, (v) => parseFloat(v));
types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${v} exceeds JS safe integer range`);
  return n;
});

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

const opOf = (text: string) => (text.trimStart().split(/\s+/, 1)[0] ?? 'UNKNOWN').toUpperCase().slice(0, 12);

/** A transaction handle. `afterCommit` hooks run only if the transaction commits (cache invalidation, etc.). */
export class Tx implements Queryable {
  private hooks: Array<() => Promise<void> | void> = [];
  constructor(
    private readonly client: PoolClient,
    private readonly metrics: Metrics | undefined,
    private readonly poolName: string,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    const end = this.metrics?.dbDuration.startTimer({ op: opOf(text), pool: this.poolName });
    try {
      return await this.client.query<R>(text, values as unknown[]);
    } finally {
      end?.();
    }
  }

  afterCommit(fn: () => Promise<void> | void): void {
    this.hooks.push(fn);
  }

  /** @internal */
  takeHooks() {
    const h = this.hooks;
    this.hooks = [];
    return h;
  }
}

export interface TxOptions {
  isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  /** retries on serialization failure / deadlock (default 3 attempts) */
  attempts?: number;
}

export class Db implements Queryable {
  constructor(
    private readonly primary: Pool,
    private readonly replica: Pool | undefined,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {
    primary.on('error', (e) => logger.error({ err: e }, 'idle primary pool client error'));
    replica?.on('error', (e) => logger.error({ err: e }, 'idle replica pool client error'));
    if (metrics) {
      const report = (name: string, pool: Pool) => {
        metrics.dbPool.set({ pool: name, state: 'total' }, pool.totalCount);
        metrics.dbPool.set({ pool: name, state: 'idle' }, pool.idleCount);
        metrics.dbPool.set({ pool: name, state: 'waiting' }, pool.waitingCount);
      };
      metrics.collectors.push(() => {
        report('primary', primary);
        if (replica) report('replica', replica);
      });
    }
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    return this.timed(this.primary, 'primary', text, values);
  }

  /** Read-only queries that tolerate replication lag (search, analytics). Falls back to primary when no replica. */
  async read<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> {
    if (this.replica) return this.timed(this.replica, 'replica', text, values);
    return this.timed(this.primary, 'primary', text, values);
  }

  private async timed<R extends QueryResultRow>(pool: Pool, name: string, text: string, values?: unknown[]) {
    const end = this.metrics?.dbDuration.startTimer({ op: opOf(text), pool: name });
    try {
      return await pool.query<R>(text, values as unknown[]);
    } finally {
      end?.();
    }
  }

  async tx<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
    const attempts = opts.attempts ?? 3;
    for (let attempt = 0; ; attempt++) {
      const client = await this.primary.connect();
      const tx = new Tx(client, this.metrics, 'primary');
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
        const result = await fn(tx);
        await client.query('COMMIT');
        client.release();
        for (const hook of tx.takeHooks()) {
          try {
            await hook();
          } catch (err) {
            this.logger.warn({ err }, 'afterCommit hook failed');
          }
        }
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        // destroy the connection if the rollback itself failed/connection is broken
        client.release(err instanceof Error && /Connection terminated|ECONNRESET/.test(err.message) ? err : undefined);
        const code = pgCode(err);
        const retryable = code === PG.SERIALIZATION_FAILURE || code === PG.DEADLOCK;
        if (retryable && attempt < attempts - 1) {
          const delay = backoffDelayMs(attempt, { baseMs: 10, capMs: 200 });
          this.logger.warn({ code, attempt: attempt + 1 }, 'transaction conflict, retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  async healthy(): Promise<boolean> {
    try {
      await this.primary.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.end(), this.replica?.end()]);
  }
}

export function createDb(cfg: Config, logger: Logger, metrics: Metrics, role: 'api' | 'worker' = 'api'): Db {
  const common = {
    ssl: cfg.db.ssl ? { rejectUnauthorized: true } : undefined,
    max: cfg.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    // Guard rails: no runaway queries, no leaked open transactions, no unbounded lock waits.
    statement_timeout: role === 'worker' ? Math.max(cfg.db.statementTimeoutMs, 30_000) : cfg.db.statementTimeoutMs,
    idle_in_transaction_session_timeout: 30_000,
    application_name: `${cfg.serviceName}-${role}`,
    options: '-c lock_timeout=5000',
  };
  const primary = new Pool({ connectionString: cfg.db.url, ...common });
  const replica = cfg.db.readUrl ? new Pool({ connectionString: cfg.db.readUrl, ...common }) : undefined;
  return new Db(primary, replica, logger, metrics);
}
