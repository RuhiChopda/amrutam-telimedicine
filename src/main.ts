import './tracing';
import 'dotenv/config';
import { createServer } from 'node:http';
import { loadConfig } from './config/env';
import { buildContainer } from './container';
import { buildApp } from './http/app';
import { createLogger } from './shared/logger';
import { connectRedis, createRedis } from './shared/redis';
import type Redis from 'ioredis';
import { shutdownTracing } from './tracing';

async function main() {
  const cfg = loadConfig();
  const logger = createLogger({ level: cfg.logLevel, service: cfg.serviceName });
  let redis: Redis | undefined;
  if (cfg.redis.url) {
    redis = createRedis(cfg.redis.url, logger);
    await connectRedis(redis, logger);
  }
  const container = await buildContainer(cfg, logger, 'api', { redis });
  const app = await buildApp(container);

  // Prometheus scrape endpoint on a SEPARATE internal port: never exposed through the public load balancer.
  const metricsServer = cfg.metricsPort
    ? createServer(async (req, res) => {
        if (req.url === '/metrics') {
          res.setHeader('Content-Type', container.metrics.registry.contentType);
          res.end(await container.metrics.render());
        } else {
          res.statusCode = 404;
          res.end();
        }
      }).listen(cfg.metricsPort, '0.0.0.0')
    : undefined;

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  logger.info({ port: cfg.port, metricsPort: cfg.metricsPort, env: cfg.env }, 'api listening');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down: draining connections');
    const force = setTimeout(() => process.exit(1), 25_000);
    force.unref();
    try {
      await app.close(); // stops accepting, waits for in-flight requests
      metricsServer?.close();
      await container.db.close();
      redis?.disconnect();
      await shutdownTracing();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
}

main().catch((err) => {
  console.error('fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
