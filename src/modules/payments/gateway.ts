import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from '../../shared/logger';
import type { Metrics } from '../../shared/metrics';
import { CircuitBreaker, CircuitOpenError, retry, TimeoutError, withTimeout } from '../../shared/retry';
import { safeEqual } from '../../shared/crypto';

export interface CreateIntentRequest {
  /** Provider-side idempotency key: retrying with the same key must return the same intent. */
  idempotencyKey: string;
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
}

export interface PaymentGateway {
  readonly name: string;
  createIntent(req: CreateIntentRequest): Promise<{ providerRef: string; clientSecret: string }>;
  voidIntent(providerRef: string, idempotencyKey: string): Promise<void>;
  refund(req: { providerRef: string; amountMinor: number; idempotencyKey: string }): Promise<{ refundRef: string }>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/**
 * Deterministic in-memory gateway for local development, tests and demos. Supports failure injection so retry,
 * circuit-breaker and saga-compensation behaviour can be exercised without a real PSP.
 * Production uses a real PSP adapter implementing the same interface (see docs/architecture.md).
 */
export class MockGateway implements PaymentGateway {
  readonly name = 'mock';
  private intents = new Map<string, { providerRef: string; clientSecret: string }>();
  private voided = new Set<string>();
  private refunds = new Map<string, string>();
  private failuresRemaining = 0;
  private failureRetryable = true;
  calls = { createIntent: 0, voidIntent: 0, refund: 0 };

  constructor(
    private readonly failureRate = 0,
    private readonly latencyMs = 0,
  ) {}

  /** Make the next `n` calls fail (retryable by default). */
  failNext(n: number, retryable = true): void {
    this.failuresRemaining = n;
    this.failureRetryable = retryable;
  }

  private async maybeFail(): Promise<void> {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new GatewayError('mock gateway: injected failure', this.failureRetryable);
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) throw new GatewayError('mock gateway: random failure', true);
  }

  async createIntent(req: CreateIntentRequest) {
    this.calls.createIntent++;
    await this.maybeFail();
    const existing = this.intents.get(req.idempotencyKey);
    if (existing) return existing;
    const intent = { providerRef: `pi_${randomUUID().replace(/-/g, '').slice(0, 24)}`, clientSecret: `cs_${randomUUID().replace(/-/g, '')}` };
    this.intents.set(req.idempotencyKey, intent);
    return intent;
  }

  async voidIntent(providerRef: string): Promise<void> {
    this.calls.voidIntent++;
    await this.maybeFail();
    this.voided.add(providerRef);
  }

  isVoided(providerRef: string): boolean {
    return this.voided.has(providerRef);
  }

  async refund(req: { providerRef: string; amountMinor: number; idempotencyKey: string }) {
    this.calls.refund++;
    await this.maybeFail();
    let ref = this.refunds.get(req.idempotencyKey);
    if (!ref) {
      ref = `re_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      this.refunds.set(req.idempotencyKey, ref);
    }
    return { refundRef: ref };
  }
}

/**
 * Wraps any gateway with the resilience policy for calls to a third party:
 *   per-attempt timeout → bounded retries with exponential backoff + full jitter (only for retryable errors) →
 *   circuit breaker so a hard-down PSP fails fast instead of tying up workers.
 * The outer durable job retry (see queue.ts) covers outages longer than the in-process retry budget.
 */
export class ResilientGateway implements PaymentGateway {
  readonly name: string;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly inner: PaymentGateway,
    private readonly logger: Logger,
    private readonly metrics?: Metrics,
    private readonly opts = { timeoutMs: 3000, attempts: 3, baseMs: 100, capMs: 1500 },
  ) {
    this.name = inner.name;
    this.breaker = new CircuitBreaker(`gateway-${inner.name}`, {
      failureThreshold: 5,
      cooldownMs: 10_000,
      onStateChange: (s) => {
        logger.warn({ state: s, gateway: inner.name }, 'payment gateway circuit state changed');
        metrics?.circuitState.set({ name: `gateway-${inner.name}` }, s === 'closed' ? 0 : s === 'half_open' ? 1 : 2);
      },
    });
  }

  private static retryable(err: unknown): boolean {
    if (err instanceof GatewayError) return err.retryable;
    return err instanceof TimeoutError;
  }

  private async call<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await this.breaker.exec(
        () =>
          retry(() => withTimeout(() => fn(), this.opts.timeoutMs, `gateway.${op}`), {
            attempts: this.opts.attempts,
            baseMs: this.opts.baseMs,
            capMs: this.opts.capMs,
            isRetryable: ResilientGateway.retryable,
            onRetry: (err, attempt, delay) => this.logger.warn({ op, attempt, delay, err: (err as Error).message }, 'gateway call retry'),
          }),
        // a non-retryable business error (e.g. card declined) must not trip the breaker
        (e) => ResilientGateway.retryable(e),
      );
      this.metrics?.gatewayCalls.inc({ op, outcome: 'success' });
      return out;
    } catch (err) {
      this.metrics?.gatewayCalls.inc({ op, outcome: err instanceof CircuitOpenError ? 'circuit_open' : 'error' });
      throw err;
    }
  }

  createIntent(req: CreateIntentRequest) {
    return this.call('create_intent', () => this.inner.createIntent(req));
  }
  voidIntent(providerRef: string, idempotencyKey: string) {
    return this.call('void', () => this.inner.voidIntent(providerRef, idempotencyKey));
  }
  refund(req: { providerRef: string; amountMinor: number; idempotencyKey: string }) {
    return this.call('refund', () => this.inner.refund(req));
  }
}

/* ------------------------------------------------------------------------------------------------ webhooks */
/** Stripe-style scheme: header `t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<rawBody>")>`. */
export function signWebhook(secret: string, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${nowSeconds}.${rawBody}`).digest('hex');
  return `t=${nowSeconds},v1=${sig}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string | Buffer,
  header: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false; // replay window
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return safeEqual(expected, v1);
}
