import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared/clock';
import { requestContext } from '../../shared/context';
import type { Db } from '../../shared/db';
import { PermanentJobError } from '../../shared/errors';
import type { Logger } from '../../shared/logger';
import type { Metrics } from '../../shared/metrics';
import { withTimeout } from '../../shared/retry';
import { withSpan } from '../../shared/telemetry';
import type { Job, JobQueue } from './queue';

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

export interface WorkerOptions {
  concurrency: number;
  pollMs: number;
  leaseSeconds: number;
}

export class JobWorker {
  readonly workerId = `w-${randomUUID().slice(0, 8)}`;
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private loop?: Promise<void>;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly opts: WorkerOptions,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  /** Claims up to the free capacity and processes the batch to completion. Returns the number of jobs processed. */
  async runOnce(): Promise<number> {
    const free = this.opts.concurrency - this.inFlight.size;
    if (free <= 0) return 0;
    const jobs = await this.queue.claim(this.workerId, free, this.opts.leaseSeconds);
    await Promise.all(jobs.map((j) => this.track(this.process(j))));
    return jobs.length;
  }

  private track(p: Promise<void>): Promise<void> {
    this.inFlight.add(p);
    return p.finally(() => this.inFlight.delete(p));
  }

  private async process(job: Job): Promise<void> {
    const handler = this.handlers[job.type];
    const end = this.metrics.jobDuration.startTimer({ type: job.type });
    await requestContext.run({ requestId: `job:${job.id}` }, () =>
      withSpan(`job ${job.type}`, { 'job.id': job.id, 'job.type': job.type, 'job.attempt': job.attempts }, async () => {
        try {
          if (!handler) throw new PermanentJobError(`No handler for job type "${job.type}"`);
          await withTimeout(() => handler(job.payload, job), this.opts.leaseSeconds * 800, `job ${job.type}`);
          await this.queue.complete(job.id);
          this.metrics.jobsProcessed.inc({ type: job.type, outcome: 'success' });
        } catch (err) {
          const status = await this.queue.fail(job, err).catch((e) => {
            this.logger.error({ err: e, jobId: job.id }, 'failed to record job failure (lease will expire and retry)');
            return 'PENDING' as const;
          });
          this.metrics.jobsProcessed.inc({ type: job.type, outcome: status === 'DEAD' ? 'dead' : 'retry' });
          this.logger[status === 'DEAD' ? 'error' : 'warn'](
            { err, jobId: job.id, type: job.type, attempt: job.attempts, status },
            'job failed',
          );
        } finally {
          end();
        }
      }),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let n = 0;
        try {
          n = await this.runOnce();
        } catch (err) {
          this.logger.error({ err }, 'worker poll failed');
        }
        // Busy queue: poll again immediately; idle: back off to the poll interval.
        if (n === 0) await new Promise((r) => setTimeout(r, this.opts.pollMs));
      }
    })();
  }

  /** Graceful shutdown: stop claiming, wait for in-flight jobs. */
  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
  }
}

export interface RecurringTask {
  name: string;
  intervalSeconds: number;
  run: () => Promise<void>;
}

/**
 * Leader-less scheduler. Every worker instance runs this loop; for each task exactly one instance wins the right to run
 * per interval via an atomic compare-and-set on recurring_tasks.last_run_at. No ZooKeeper/Redis lock, and a dead
 * instance is simply replaced by whichever instance claims next.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private nextAttempt = new Map<string, number>();
  private busy = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly tasks: RecurringTask[],
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
  ) {}

  async register(): Promise<void> {
    for (const t of this.tasks) {
      await this.db.query('INSERT INTO recurring_tasks (name) VALUES ($1) ON CONFLICT DO NOTHING', [t.name]);
    }
  }

  /** Tries every task once. Returns names of tasks this instance ran. */
  async tick(force = false): Promise<string[]> {
    const ran: string[] = [];
    for (const t of this.tasks) {
      const now = this.clock.now();
      if (!force && (this.nextAttempt.get(t.name) ?? 0) > now.getTime()) continue;
      // jittered local re-check time so instances do not all poll in lock-step
      this.nextAttempt.set(t.name, now.getTime() + t.intervalSeconds * 1000 * (0.5 + Math.random() * 0.4));
      if (this.busy.has(t.name)) continue;
      const claimed = await this.db.query(
        `UPDATE recurring_tasks SET last_run_at = $2 WHERE name = $1 AND last_run_at <= $3`,
        [t.name, now, new Date(now.getTime() - t.intervalSeconds * 1000)],
      );
      if (claimed.rowCount !== 1) continue;
      this.busy.add(t.name);
      ran.push(t.name);
      try {
        await withSpan(`task ${t.name}`, { 'task.name': t.name }, () => requestContext.run({ requestId: `task:${t.name}` }, t.run));
        this.metrics.schedulerRuns.inc({ task: t.name, outcome: 'success' });
      } catch (err) {
        this.metrics.schedulerRuns.inc({ task: t.name, outcome: 'error' });
        this.logger.error({ err, task: t.name }, 'recurring task failed');
        await this.db
          .query('UPDATE recurring_tasks SET last_error = $2 WHERE name = $1', [t.name, String((err as Error).message).slice(0, 500)])
          .catch(() => undefined);
      } finally {
        this.busy.delete(t.name);
      }
    }
    return ran;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((e) => this.logger.error({ err: e }, 'scheduler tick failed')), 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
