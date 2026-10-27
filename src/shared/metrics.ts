import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * All application metrics in one place (names are part of the operational contract: dashboards and alert rules in
 * infra/observability reference them). Labels are deliberately low-cardinality: route *templates*, never raw URLs/ids.
 */
export class Metrics {
  readonly registry = new Registry();
  /** Callbacks that refresh pull-style gauges (e.g. DB pool stats) at scrape time. */
  readonly collectors: Array<() => void> = [];

  readonly httpDuration: Histogram<'method' | 'route' | 'status_class'>;
  readonly httpInFlight: Gauge;
  readonly dbDuration: Histogram<'op' | 'pool'>;
  readonly dbPool: Gauge<'pool' | 'state'>;
  readonly cacheOps: Counter<'cache' | 'result'>;
  readonly jobsProcessed: Counter<'type' | 'outcome'>;
  readonly jobDuration: Histogram<'type'>;
  readonly jobsQueueDepth: Gauge<'status'>;
  readonly jobOldestPendingAge: Gauge;
  readonly bookings: Counter<'outcome'>;
  readonly consultationTransitions: Counter<'to'>;
  readonly payments: Counter<'event'>;
  readonly gatewayCalls: Counter<'op' | 'outcome'>;
  readonly circuitState: Gauge<'name'>;
  readonly sagaCompensations: Counter<'reason'>;
  readonly idempotentReplays: Counter<string>;
  readonly rateLimited: Counter<'scope'>;
  readonly authEvents: Counter<'event'>;
  readonly auditEvents: Counter<'outcome'>;
  readonly schedulerRuns: Counter<'task' | 'outcome'>;

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    const registers = [this.registry];
    if (opts.defaultMetrics !== false) collectDefaultMetrics({ register: this.registry });

    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency by route template',
      labelNames: ['method', 'route', 'status_class'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5],
      registers,
    });
    this.httpInFlight = new Gauge({ name: 'http_requests_in_flight', help: 'In-flight HTTP requests', registers });
    this.dbDuration = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Postgres query latency',
      labelNames: ['op', 'pool'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers,
    });
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.dbPool = new Gauge({
      name: 'db_pool_connections',
      help: 'pg pool connections',
      labelNames: ['pool', 'state'],
      registers,
      collect() {
        self.collectors.forEach((f) => f());
      },
    });
    this.cacheOps = new Counter({ name: 'cache_operations_total', help: 'Cache lookups', labelNames: ['cache', 'result'], registers });
    this.jobsProcessed = new Counter({ name: 'jobs_processed_total', help: 'Jobs processed', labelNames: ['type', 'outcome'], registers });
    this.jobDuration = new Histogram({
      name: 'job_duration_seconds',
      help: 'Job handler duration',
      labelNames: ['type'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 15, 60],
      registers,
    });
    this.jobsQueueDepth = new Gauge({ name: 'jobs_queue_depth', help: 'Jobs by status', labelNames: ['status'], registers });
    this.jobOldestPendingAge = new Gauge({
      name: 'jobs_oldest_pending_age_seconds',
      help: 'Age of the oldest runnable pending job',
      registers,
    });
    this.bookings = new Counter({ name: 'bookings_total', help: 'Booking attempts by outcome', labelNames: ['outcome'], registers });
    this.consultationTransitions = new Counter({
      name: 'consultation_transitions_total',
      help: 'Consultation status transitions',
      labelNames: ['to'],
      registers,
    });
    this.payments = new Counter({ name: 'payment_events_total', help: 'Payment lifecycle events', labelNames: ['event'], registers });
    this.gatewayCalls = new Counter({
      name: 'payment_gateway_calls_total',
      help: 'Outbound payment gateway calls',
      labelNames: ['op', 'outcome'],
      registers,
    });
    this.circuitState = new Gauge({
      name: 'circuit_breaker_state',
      help: '0=closed 1=half_open 2=open',
      labelNames: ['name'],
      registers,
    });
    this.sagaCompensations = new Counter({
      name: 'saga_compensations_total',
      help: 'Compensating actions executed',
      labelNames: ['reason'],
      registers,
    });
    this.idempotentReplays = new Counter({ name: 'idempotent_replays_total', help: 'Replayed idempotent responses', registers });
    this.rateLimited = new Counter({ name: 'rate_limited_total', help: 'Requests rejected by rate limiter', labelNames: ['scope'], registers });
    this.authEvents = new Counter({ name: 'auth_events_total', help: 'Authentication events', labelNames: ['event'], registers });
    this.auditEvents = new Counter({ name: 'audit_events_total', help: 'Audit records written', labelNames: ['outcome'], registers });
    this.schedulerRuns = new Counter({
      name: 'scheduler_runs_total',
      help: 'Recurring task runs',
      labelNames: ['task', 'outcome'],
      registers,
    });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}
