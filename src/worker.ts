import './tracing';
import 'dotenv/config';
import { createServer } from 'node:http';
import { loadConfig } from './config/env';
import { buildContainer } from './container';
import { JobWorker, Scheduler } from './modules/jobs/worker';
import { createLogger } from './shared/logger';
import { connectRedis, createRedis } from './shared/redis';
import type Redis from 'ioredis';
import { shutdownTracing } from './tracing';

async function main() {
  const cfg = loadConfig({ ...process.env, SERVICE_NAME: process.env.SERVICE_NAME ?? 'amrutam-worker' });
  const logger = createLogger({ level: cfg.logLevel, service: cfg.serviceName });
  let redis: Redis | undefined;
  if (cfg.redis.url) {
    redis = createRedis(cfg.redis.url, logger);
    await connectRedis(redis, logger);
  }
  const c = await buildContainer(cfg, logger, 'worker', { redis });
  const worker = new JobWorker(c.queue, c.handlers, { concurrency: cfg.worker.concurrency, pollMs: cfg.worker.pollMs, leaseSeconds: 60 }, logger, c.metrics);
  const scheduler = new Scheduler(c.db, c.recurringTasks, c.clock, logger, c.metrics);
  await scheduler.register();
  worker.start();
  scheduler.start();

  // metrics + liveness for the worker deployment
  const srv = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.setHeader('Content-Type', c.metrics.registry.contentType);
      res.end(await c.metrics.render());
    } else if (req.url === '/healthz') {
      res.end('ok');
    } else {
      res.statusCode = 404;
      res.end();
    }
  }).listen(cfg.metricsPort || 9464, '0.0.0.0');
  logger.info({ workerId: worker.workerId, concurrency: cfg.worker.concurrency }, 'worker started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker draining');
    const force = setTimeout(() => process.exit(1), 55_000);
    force.unref();
    scheduler.stop();
    await worker.stop(); // finish in-flight jobs; unfinished leases expire and are retried elsewhere
    srv.close();
    await c.db.close();
    redis?.disconnect();
    await shutdownTracing();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal worker error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
