import type Redis from 'ioredis';
import type { Logger } from './logger';
import type { Metrics } from './metrics';
import { CircuitBreaker } from './retry';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

const LUA = `
local c = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if c == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
`;

/**
 * Fixed-window rate limiter backed by Redis (atomic Lua) so limits hold across all API instances.
 * If Redis is unavailable it FAILS OPEN to a per-instance in-memory limiter — availability of the booking path matters
 * more than perfect limiting, and per-instance limits still bound abuse (limit × instance count).
 */
export class RateLimiter {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly redis: Redis | undefined,
    private readonly prefix: string,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
  ) {
    this.breaker = new CircuitBreaker('redis-ratelimit', { failureThreshold: 5, cooldownMs: 5000 });
    redis?.defineCommand('rlHit', { numberOfKeys: 1, lua: LUA });
  }

  async hit(scope: string, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const full = `${this.prefix}rl:${scope}:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    let count: number;
    let ttl: number;
    if (this.redis) {
      try {
        const [c, t] = await this.breaker.exec(
          () => (this.redis as unknown as { rlHit(k: string, w: number): Promise<[number, number]> }).rlHit(full, windowSeconds),
        );
        count = c;
        ttl = t;
      } catch (err) {
        this.logger.debug({ err: (err as Error).message }, 'rate limiter redis failure; using in-memory fallback');
        ({ count, ttl } = this.memoryHit(full, windowSeconds));
      }
    } else {
      ({ count, ttl } = this.memoryHit(full, windowSeconds));
    }
    const allowed = count <= limit;
    if (!allowed) this.metrics?.rateLimited.inc({ scope });
    return { allowed, limit, remaining: Math.max(0, limit - count), retryAfterSeconds: Math.max(1, ttl) };
  }

  private memoryHit(key: string, windowSeconds: number) {
    const now = Date.now();
    if (this.memory.size > 50_000) {
      for (const [k, v] of this.memory) if (v.resetAt < now) this.memory.delete(k);
    }
    let e = this.memory.get(key);
    if (!e || e.resetAt < now) {
      e = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.memory.set(key, e);
    }
    e.count++;
    return { count: e.count, ttl: Math.ceil((e.resetAt - now) / 1000) };
  }
}
