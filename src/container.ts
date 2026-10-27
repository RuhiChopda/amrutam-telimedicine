import type Redis from 'ioredis';
import type { Config } from './config/env';
import { AdminService } from './modules/admin/service';
import { AnalyticsService } from './modules/admin/analytics';
import { AuditService } from './modules/audit/service';
import { AuthService } from './modules/auth/service';
import { TokenService } from './modules/auth/tokens';
import { BookingService } from './modules/consultations/booking';
import { LifecycleService } from './modules/consultations/lifecycle';
import { DoctorService } from './modules/doctors/service';
import { IdempotencyService } from './modules/idempotency/service';
import { JobQueue } from './modules/jobs/queue';
import type { JobHandlers, RecurringTask } from './modules/jobs/worker';
import { KeyRotationService } from './modules/keys/rotation';
import { LogNotifier, type Notifier } from './modules/notifications/notifier';
import { MockGateway, ResilientGateway, type PaymentGateway } from './modules/payments/gateway';
import { PaymentService } from './modules/payments/service';
import { UsersService } from './modules/users/service';
import { MemoryCache, RedisCache, type Cache } from './shared/cache';
import { systemClock, type Clock } from './shared/clock';
import { FieldCrypto } from './shared/crypto';
import { createDb, type Db } from './shared/db';
import type { Logger } from './shared/logger';
import { Metrics } from './shared/metrics';
import { RateLimiter } from './shared/rateLimiter';

export interface Overrides {
  clock?: Clock;
  gateway?: PaymentGateway;
  notifier?: Notifier;
  db?: Db;
  redis?: Redis;
  metrics?: Metrics;
}

export interface Container {
  cfg: Config;
  logger: Logger;
  metrics: Metrics;
  clock: Clock;
  db: Db;
  redis?: Redis;
  cache: Cache;
  rateLimiter: RateLimiter;
  crypto: FieldCrypto;
  tokens: TokenService;
  audit: AuditService;
  idempotency: IdempotencyService;
  queue: JobQueue;
  auth: AuthService;
  users: UsersService;
  doctors: DoctorService;
  booking: BookingService;
  lifecycle: LifecycleService;
  payments: PaymentService;
  analytics: AnalyticsService;
  admin: AdminService;
  keyRotation: KeyRotationService;
  gateway: PaymentGateway;
  notifier: Notifier;
  handlers: JobHandlers;
  recurringTasks: RecurringTask[];
}

/** Composition root: the only place that knows concrete classes. Everything else receives interfaces via constructors. */
export async function buildContainer(cfg: Config, logger: Logger, role: 'api' | 'worker', o: Overrides = {}): Promise<Container> {
  const metrics = o.metrics ?? new Metrics();
  const clock = o.clock ?? systemClock;
  const db = o.db ?? createDb(cfg, logger, metrics, role);
  const redis = o.redis;
  const cache: Cache = redis ? new RedisCache(redis, cfg.redis.prefix, logger, metrics) : new MemoryCache(metrics);
  const rateLimiter = new RateLimiter(redis, cfg.redis.prefix, logger, metrics);
  const crypto = new FieldCrypto(cfg.keys.dataKeys, cfg.keys.activeDataKeyId, cfg.keys.blindIndexKey);
  const tokens = await TokenService.create(cfg.jwt);
  const audit = new AuditService(db, cfg.keys.auditHmacKey, clock, logger, metrics);
  const idempotency = new IdempotencyService(db, metrics);
  const queue = new JobQueue(db, clock, metrics);
  const auth = new AuthService(db, crypto, tokens, audit, cache, clock, cfg, metrics);
  const users = new UsersService(db, crypto, audit);
  const doctors = new DoctorService(db, cache, audit, clock, cfg);
  const booking = new BookingService(db, audit, queue, cache, doctors, crypto, clock, cfg, metrics);
  const lifecycle = new LifecycleService(db, booking, doctors, audit, queue, crypto, cfg.keys.signingKey, clock, cfg, metrics);
  const gateway = o.gateway ?? new ResilientGateway(new MockGateway(cfg.payments.mockFailureRate), logger, metrics);
  const payments = new PaymentService(db, gateway, booking, queue, audit, crypto, cfg.payments.webhookSecret, clock, metrics);
  const analytics = new AnalyticsService(db, cache, clock);
  const admin = new AdminService(db, queue, audit);
  const keyRotation = new KeyRotationService(db, crypto, logger);
  const notifier = o.notifier ?? new LogNotifier(logger);

  const handlers: JobHandlers = {
    'payment.create_intent': (p) => payments.createIntent(String(p.paymentId)),
    'payment.void': (p) => payments.voidIntent(String(p.paymentId)),
    'payment.refund': (p) => payments.refund(String(p.paymentId)),
    notify: (p) => notifier.send({ userId: String(p.userId), template: String(p.template), data: p.data as Record<string, unknown> | undefined }),
  };

  const recurringTasks: RecurringTask[] = [
    { name: 'holds.expire', intervalSeconds: 5, run: async () => void (await booking.expireHolds()) },
    { name: 'jobs.reclaim', intervalSeconds: 15, run: async () => void (await queue.reclaimExpired()) },
    { name: 'jobs.stats', intervalSeconds: 10, run: () => queue.publishStats() },
    { name: 'consultations.no_show', intervalSeconds: 60, run: async () => void (await lifecycle.markNoShows()) },
    { name: 'audit.checkpoint', intervalSeconds: 300, run: async () => void (await audit.checkpoint()) },
    { name: 'analytics.rollup', intervalSeconds: 300, run: async () => void (await analytics.rollupRecent()) },
    {
      name: 'partitions.ensure',
      intervalSeconds: 6 * 3600,
      run: async () => {
        await db.query(`SELECT ensure_monthly_partitions('consultations', 0, 6)`);
        await db.query(`SELECT ensure_monthly_partitions('audit_logs', 0, 6)`);
      },
    },
    {
      name: 'cleanup',
      intervalSeconds: 3600,
      run: async () => {
        await queue.deleteFinished(new Date(clock.now().getTime() - 7 * 86_400_000));
        await db.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
        await db.query(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
        await db.query(`DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`);
      },
    },
    { name: 'keys.reencrypt', intervalSeconds: 60, run: async () => void (await keyRotation.reencryptBatch()) },
  ];

  return { cfg, logger, metrics, clock, db, redis, cache, rateLimiter, crypto, tokens, audit, idempotency, queue, auth, users, doctors, booking, lifecycle, payments, analytics, admin, keyRotation, gateway, notifier, handlers, recurringTasks };
}
