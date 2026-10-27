import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Clock } from '../../shared/clock';
import { currentContext } from '../../shared/context';
import { hmacSha256, safeEqual, stableStringify } from '../../shared/crypto';
import type { Db, Queryable } from '../../shared/db';
import type { Logger } from '../../shared/logger';
import type { Metrics } from '../../shared/metrics';
import { currentTraceId } from '../../shared/telemetry';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  actorRole?: string | null;
  entityType?: string;
  entityId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  /** Identifiers, field NAMES and non-sensitive facts only. Never PHI/PII values. */
  metadata?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  created_at: Date;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  outcome: string;
  request_id: string | null;
  trace_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  sig?: Buffer;
}

export interface AuditFilter {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
  limit: number;
  cursor?: { createdAt: string; id: number };
}

export interface VerifyReport {
  ok: boolean;
  rowsChecked: number;
  badSignatures: number[];
  checkpointsChecked: number;
  badCheckpoints: number[];
}

const CHECKPOINT_LAG_MS = 120_000; // > idle_in_transaction_session_timeout + statement_timeout: all rows in the window are committed

export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly hmacKey: Buffer,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {}

  private canonical(r: {
    createdAt: Date;
    actorId: string | null;
    actorRole: string | null;
    action: string;
    entityType: string | null;
    entityId: string | null;
    outcome: string;
    requestId: string | null;
    metadata: unknown;
  }): string {
    return [
      r.createdAt.toISOString(),
      r.actorId ?? '',
      r.actorRole ?? '',
      r.action,
      r.entityType ?? '',
      r.entityId ?? '',
      r.outcome,
      r.requestId ?? '',
      stableStringify(r.metadata),
    ].join('|');
  }

  /**
   * Writes one audit record. Pass the caller's transaction so the audit row commits atomically with the change it
   * describes (no change without a record, no record of a rolled-back change).
   */
  async record(q: Queryable, e: AuditEntry): Promise<void> {
    const ctx = currentContext();
    const createdAt = this.clock.now();
    const actorId = e.actorId === undefined ? (ctx?.actor?.id ?? null) : e.actorId;
    const actorRole = e.actorRole === undefined ? (ctx?.actor?.role ?? null) : e.actorRole;
    const outcome = e.outcome ?? 'SUCCESS';
    const metadata = e.metadata ?? {};
    const requestId = ctx?.requestId ?? null;
    const sig = hmacSha256(
      this.hmacKey,
      this.canonical({
        createdAt,
        actorId,
        actorRole,
        action: e.action,
        entityType: e.entityType ?? null,
        entityId: e.entityId ?? null,
        outcome,
        requestId,
        metadata,
      }),
    );
    const ip = ctx?.ip && isIP(ctx.ip) ? ctx.ip : null;
    try {
      await q.query(
        `INSERT INTO audit_logs (created_at, actor_id, actor_role, action, entity_type, entity_id, outcome, ip,
                                 user_agent, request_id, trace_id, metadata, sig)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          createdAt,
          actorId,
          actorRole,
          e.action,
          e.entityType ?? null,
          e.entityId ?? null,
          outcome,
          ip,
          ctx?.userAgent?.slice(0, 300) ?? null,
          requestId,
          ctx?.traceId ?? currentTraceId() ?? null,
          JSON.stringify(metadata),
          sig,
        ],
      );
      this.metrics?.auditEvents.inc({ outcome: 'written' });
    } catch (err) {
      this.metrics?.auditEvents.inc({ outcome: 'failed' });
      throw err; // fail closed: an unauditable action must not succeed
    }
  }

  /** For events outside any business transaction (failed logins, authorization denials). */
  async recordStandalone(e: AuditEntry): Promise<void> {
    try {
      await this.record(this.db, e);
    } catch (err) {
      this.logger.error({ err, action: e.action }, 'failed to write standalone audit record');
    }
  }

  async list(f: AuditFilter): Promise<{ items: AuditRow[]; next?: { createdAt: string; id: number } }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    // Always bound by time so Postgres can prune partitions.
    add('created_at >= ?', f.from ?? new Date(this.clock.now().getTime() - 7 * 86_400_000));
    if (f.to) add('created_at <= ?', f.to);
    if (f.actorId) add('actor_id = ?', f.actorId);
    if (f.entityType) add('entity_type = ?', f.entityType);
    if (f.entityId) add('entity_id = ?', f.entityId);
    if (f.action) add('action = ?', f.action);
    if (f.outcome) add('outcome = ?', f.outcome);
    if (f.cursor) {
      params.push(f.cursor.createdAt, f.cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
    }
    params.push(f.limit + 1);
    const { rows } = await this.db.read<AuditRow>(
      `SELECT id, created_at, actor_id, actor_role, action, entity_type, entity_id, outcome, request_id, trace_id,
              host(ip) AS ip, metadata
         FROM audit_logs WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, f.limit);
    const last = items[items.length - 1];
    return {
      items,
      next: rows.length > f.limit && last ? { createdAt: last.created_at.toISOString(), id: last.id } : undefined,
    };
  }

  /** Seals a window of audit rows into a hash-chained, HMAC'd checkpoint. Run periodically by the scheduler. */
  async checkpoint(): Promise<{ rows: number } | null> {
    const cutoff = new Date(this.clock.now().getTime() - CHECKPOINT_LAG_MS);
    return this.db.tx(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(727275)');
      const last = (
        await tx.query<{ period_end: Date; digest: Buffer }>(
          'SELECT period_end, digest FROM audit_checkpoints ORDER BY id DESC LIMIT 1',
        )
      ).rows[0];
      const start = last?.period_end ?? new Date(0);
      if (cutoff <= start) return null;
      const sigs = (
        await tx.query<{ sig: Buffer }>(
          'SELECT sig FROM audit_logs WHERE created_at > $1 AND created_at <= $2 ORDER BY created_at, id',
          [start, cutoff],
        )
      ).rows;
      if (sigs.length === 0) return null;
      const digest = this.digest(last?.digest ?? null, sigs.map((r) => r.sig));
      await tx.query(
        `INSERT INTO audit_checkpoints (period_start, period_end, row_count, digest, prev_digest) VALUES ($1,$2,$3,$4,$5)`,
        [start, cutoff, sigs.length, digest, last?.digest ?? null],
      );
      return { rows: sigs.length };
    });
  }

  private digest(prev: Buffer | null, sigs: Buffer[]): Buffer {
    const h = createHmac('sha256', this.hmacKey);
    h.update(prev ?? Buffer.alloc(0));
    for (const s of sigs) h.update(s);
    return h.digest();
  }

  /** Recomputes every row signature and every checkpoint digest in [from, to]. Detects edits, forgeries and deletions. */
  async verify(from: Date, to: Date): Promise<VerifyReport> {
    const report: VerifyReport = { ok: true, rowsChecked: 0, badSignatures: [], checkpointsChecked: 0, badCheckpoints: [] };
    let cursor: { createdAt: Date; id: number } | undefined;
    for (;;) {
      const { rows } = await this.db.query<AuditRow & { sig: Buffer; created_at: Date }>(
        `SELECT id, created_at, actor_id, actor_role, action, entity_type, entity_id, outcome, request_id, metadata, sig
           FROM audit_logs
          WHERE created_at >= $1 AND created_at <= $2
            AND ($3::timestamptz IS NULL OR (created_at, id) > ($3::timestamptz, $4::bigint))
          ORDER BY created_at, id LIMIT 2000`,
        [from, to, cursor?.createdAt ?? null, cursor?.id ?? 0],
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        const expected = hmacSha256(
          this.hmacKey,
          this.canonical({
            createdAt: r.created_at,
            actorId: r.actor_id,
            actorRole: r.actor_role,
            action: r.action,
            entityType: r.entity_type,
            entityId: r.entity_id,
            outcome: r.outcome,
            requestId: r.request_id,
            metadata: r.metadata,
          }),
        );
        report.rowsChecked++;
        if (!safeEqual(expected, r.sig)) report.badSignatures.push(r.id);
      }
      const lastRow = rows[rows.length - 1] as (typeof rows)[number];
      cursor = { createdAt: lastRow.created_at, id: lastRow.id };
      if (rows.length < 2000) break;
    }

    const cps = (
      await this.db.query<{ id: number; period_start: Date; period_end: Date; row_count: number; digest: Buffer; prev_digest: Buffer | null }>(
        'SELECT id, period_start, period_end, row_count, digest, prev_digest FROM audit_checkpoints WHERE period_end >= $1 AND period_start <= $2 ORDER BY id',
        [from, to],
      )
    ).rows;
    let prevDigest: Buffer | null = null;
    for (const cp of cps) {
      const sigs = (
        await this.db.query<{ sig: Buffer }>(
          'SELECT sig FROM audit_logs WHERE created_at > $1 AND created_at <= $2 ORDER BY created_at, id',
          [cp.period_start, cp.period_end],
        )
      ).rows.map((r) => r.sig);
      report.checkpointsChecked++;
      const recomputed = this.digest(cp.prev_digest, sigs);
      const chainOk = prevDigest === null || (cp.prev_digest !== null && safeEqual(cp.prev_digest, prevDigest));
      if (!safeEqual(recomputed, cp.digest) || sigs.length !== cp.row_count || !chainOk) report.badCheckpoints.push(cp.id);
      prevDigest = cp.digest;
    }
    report.ok = report.badSignatures.length === 0 && report.badCheckpoints.length === 0;
    return report;
  }
}
