import type Redis from 'ioredis';
import type { Logger } from './logger';
import type { Metrics } from './metrics';
import { CircuitBreaker } from './retry';

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Atomically bump a version counter (used for O(1) invalidation of whole key families). */
  incr(key: string): Promise<number>;
  getNumber(key: string): Promise<number>;
  /**
   * Cache-aside with:
   *  - single-flight: concurrent misses for one key share one loader call (prevents stampedes within an instance),
   *  - TTL jitter ±10%: keys written together do not expire together,
   *  - negative caching for `null` results (short TTL) so lookups of missing ids cannot hammer the DB.
   */
  wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
}

const NULL_SENTINEL = '__null__';
const jitter = (ttl: number) => Math.max(1, Math.round(ttl * (0.9 + Math.random() * 0.2)));

abstract class BaseCache implements Cache {
  private inflight = new Map<string, Promise<unknown>>();
  constructor(
    protected readonly name: string,
    protected readonly metrics?: Metrics,
  ) {}

  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  abstract del(...keys: string[]): Promise<void>;
  abstract incr(key: string): Promise<number>;
  abstract getNumber(key: string): Promise<number>;

  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T | typeof NULL_SENTINEL>(key);
    if (hit !== undefined) {
      this.metrics?.cacheOps.inc({ cache: this.name, result: 'hit' });
      return (hit === NULL_SENTINEL ? null : hit) as T;
    }
    this.metrics?.cacheOps.inc({ cache: this.name, result: 'miss' });
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = (async () => {
      try {
        const value = await loader();
        const isNull = value === null || value === undefined;
        await this.set(key, isNull ? NULL_SENTINEL : value, isNull ? Math.min(10, ttlSeconds) : ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

export class RedisCache extends BaseCache {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly logger: Logger,
    metrics?: Metrics,
  ) {
    super('redis', metrics);
    this.breaker = new CircuitBreaker('redis-cache', {
      failureThreshold: 5,
      cooldownMs: 5000,
      onStateChange: (s) => {
        logger.warn({ state: s }, 'redis cache circuit state changed');
        metrics?.circuitState.set({ name: 'redis-cache' }, s === 'closed' ? 0 : s === 'half_open' ? 1 : 2);
      },
    });
  }

  private async safe<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.breaker.exec(op);
    } catch (err) {
      this.metrics?.cacheOps.inc({ cache: 'redis', result: 'error' });
      this.logger.debug({ err: (err as Error).message }, 'cache op failed; falling back to source of truth');
      return fallback;
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.safe(async () => {
      const v = await this.redis.get(this.prefix + key);
      return v === null ? undefined : (JSON.parse(v) as T);
    }, undefined);
  }

  set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    return this.safe(async () => {
      await this.redis.set(this.prefix + key, JSON.stringify(value), 'EX', jitter(ttlSeconds));
    }, undefined);
  }

  del(...keys: string[]): Promise<void> {
    return this.safe(async () => {
      if (keys.length) await this.redis.del(...keys.map((k) => this.prefix + k));
    }, undefined);
  }

  incr(key: string): Promise<number> {
    return this.safe(() => this.redis.incr(this.prefix + key), 0);
  }

  getNumber(key: string): Promise<number> {
    return this.safe(async () => Number((await this.redis.get(this.prefix + key)) ?? 0), 0);
  }
}

/** In-process cache: used when Redis is not configured (local dev, unit tests). */
export class MemoryCache extends BaseCache {
  private store = new Map<string, { value: string; expiresAt: number }>();
  constructor(metrics?: Metrics) {
    super('memory', metrics);
  }
  async get<T>(key: string): Promise<T | undefined> {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return JSON.parse(e.value) as T;
  }
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value: JSON.stringify(value), expiresAt: Date.now() + jitter(ttlSeconds) * 1000 });
  }
  async del(...keys: string[]): Promise<void> {
    keys.forEach((k) => this.store.delete(k));
  }
  async incr(key: string): Promise<number> {
    const n = (await this.getNumber(key)) + 1;
    this.store.set(key, { value: String(n), expiresAt: Date.now() + 86_400_000 });
    return n;
  }
  async getNumber(key: string): Promise<number> {
    return Number((await this.get<number>(key)) ?? 0);
  }
}
