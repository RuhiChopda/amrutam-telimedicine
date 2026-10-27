import { z } from 'zod';
import { addDays, type Clock } from '../../shared/clock';
import type { Cache } from '../../shared/cache';
import type { Db } from '../../shared/db';
import { badRequest } from '../../shared/errors';

export const analyticsQuerySchema = z.strictObject({
  from: z.string().date(),
  to: z.string().date(),
  specialty: z.string().trim().max(60).optional(),
});

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Admin analytics read from a pre-aggregated daily rollup (analytics_daily), never from the OLTP consultations table, so
 * dashboards cost O(days × specialties) regardless of volume. The rollup is rebuilt incrementally by a scheduled job:
 * recent days are recomputed (late cancellations/refunds change old rows), older days are immutable.
 */
export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly clock: Clock,
  ) {}

  /** Recompute the rollup for [from, to] (UTC days). Idempotent upsert. */
  async rollup(from: Date, to: Date): Promise<number> {
    const start = new Date(`${dayStr(from)}T00:00:00Z`);
    const end = addDays(new Date(`${dayStr(to)}T00:00:00Z`), 1);
    const r = await this.db.query(
      `INSERT INTO analytics_daily (day, specialty, scheduled, confirmed, completed, cancelled, no_shows, revenue_minor, refunds_minor, computed_at)
       SELECT (c.scheduled_at AT TIME ZONE 'UTC')::date AS day,
              coalesce(c.specialty, 'unknown'),
              count(*)::int,
              count(*) FILTER (WHERE c.status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','NO_SHOW'))::int,
              count(*) FILTER (WHERE c.status = 'COMPLETED')::int,
              count(*) FILTER (WHERE c.status = 'CANCELLED')::int,
              count(*) FILTER (WHERE c.status = 'NO_SHOW')::int,
              coalesce(sum(p.amount_minor) FILTER (WHERE p.status IN ('SUCCEEDED','REFUND_PENDING','REFUNDED')), 0)::bigint,
              coalesce(sum(p.refund_amount_minor) FILTER (WHERE p.status IN ('REFUND_PENDING','REFUNDED')), 0)::bigint,
              now()
         FROM consultations c
         LEFT JOIN payments p ON p.consultation_id = c.id AND p.status NOT IN ('FAILED','VOIDED')
        WHERE c.scheduled_at >= $1 AND c.scheduled_at < $2
        GROUP BY 1, 2
       ON CONFLICT (day, specialty) DO UPDATE SET scheduled = EXCLUDED.scheduled, confirmed = EXCLUDED.confirmed,
         completed = EXCLUDED.completed, cancelled = EXCLUDED.cancelled, no_shows = EXCLUDED.no_shows,
         revenue_minor = EXCLUDED.revenue_minor, refunds_minor = EXCLUDED.refunds_minor, computed_at = now()`,
      [start, end],
    );
    await this.cache.incr('analytics:ver');
    return r.rowCount ?? 0;
  }

  async rollupRecent(days = 3): Promise<number> {
    const now = this.clock.now();
    // include upcoming days so scheduled/pending counts are visible too
    return this.rollup(addDays(now, -days), addDays(now, 14));
  }

  async summary(q: z.infer<typeof analyticsQuerySchema>) {
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(`${q.to}T00:00:00Z`);
    if (to < from || to.getTime() - from.getTime() > 366 * 86_400_000) throw badRequest('INVALID_RANGE', 'to must not precede from and the range must be at most 366 days');
    const ver = await this.cache.getNumber('analytics:ver');
    return this.cache.wrap(`analytics:${ver}:${q.from}:${q.to}:${q.specialty ?? '*'}`, 60, async () => {
      const params: unknown[] = [q.from, q.to];
      let spec = '';
      if (q.specialty) {
        params.push(q.specialty);
        spec = 'AND specialty = $3';
      }
      const daily = await this.db.read<Record<string, unknown>>(
        `SELECT day::text, sum(scheduled)::int AS scheduled, sum(confirmed)::int AS confirmed, sum(completed)::int AS completed,
                sum(cancelled)::int AS cancelled, sum(no_shows)::int AS no_shows, sum(revenue_minor)::bigint AS revenue_minor, sum(refunds_minor)::bigint AS refunds_minor
           FROM analytics_daily WHERE day BETWEEN $1 AND $2 ${spec} GROUP BY day ORDER BY day`,
        params,
      );
      const bySpecialty = await this.db.read<Record<string, unknown>>(
        `SELECT specialty, sum(scheduled)::int AS scheduled, sum(completed)::int AS completed, sum(revenue_minor)::bigint AS revenue_minor
           FROM analytics_daily WHERE day BETWEEN $1 AND $2 ${spec} GROUP BY specialty ORDER BY sum(scheduled) DESC LIMIT 50`,
        params,
      );
      const t = { scheduled: 0, confirmed: 0, completed: 0, cancelled: 0, noShows: 0, revenueMinor: 0, refundsMinor: 0 };
      for (const d of daily.rows) {
        t.scheduled += d.scheduled as number;
        t.confirmed += d.confirmed as number;
        t.completed += d.completed as number;
        t.cancelled += d.cancelled as number;
        t.noShows += d.no_shows as number;
        t.revenueMinor += d.revenue_minor as number;
        t.refundsMinor += d.refunds_minor as number;
      }
      return {
        range: { from: q.from, to: q.to },
        totals: { ...t, netRevenueMinor: t.revenueMinor - t.refundsMinor, completionRate: t.confirmed ? +(t.completed / t.confirmed).toFixed(4) : 0, cancellationRate: t.scheduled ? +(t.cancelled / t.scheduled).toFixed(4) : 0 },
        daily: daily.rows,
        bySpecialty: bySpecialty.rows,
      };
    });
  }
}
