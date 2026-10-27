import Redis from 'ioredis';
import type { Logger } from './logger';

/**
 * Redis is an optimisation and a coordination aid, never the source of truth. The client is configured to FAIL FAST
 * (no offline queue, tight command timeout, one retry) so an outage degrades to the database instead of stacking up
 * latency on every request. Callers wrap usage in a circuit breaker (see cache.ts / rateLimiter.ts).
 */
export function createRedis(url: string, logger: Logger): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 150,
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    reconnectOnError: () => false,
  });
  let lastErrLog = 0;
  client.on('error', (err) => {
    const now = Date.now();
    if (now - lastErrLog > 10_000) {
      lastErrLog = now;
      logger.warn({ err: err.message }, 'redis error (degrading gracefully)');
    }
  });
  return client;
}

export async function connectRedis(client: Redis, logger: Logger, timeoutMs = 2500): Promise<boolean> {
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('redis connect timeout')), timeoutMs)),
    ]);
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'redis unavailable at startup; running in degraded mode');
    return false;
  }
}
