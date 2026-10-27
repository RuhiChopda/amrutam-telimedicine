/**
 * Resilience primitives: exponential backoff with full jitter, per-call timeouts, and a circuit breaker.
 *
 * Full jitter (AWS Architecture Blog, "Exponential Backoff and Jitter"): sleep = random(0, min(cap, base * 2^attempt)).
 * It decorrelates retrying clients so a recovering dependency is not hit by synchronized retry waves.
 */
export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** random source, injectable for deterministic tests */
  random?: () => number;
}

export function backoffDelayMs(attempt: number, { baseMs, capMs, random = Math.random }: BackoffOptions): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  /** total attempts including the first */
  attempts: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = opts.isRetryable ? opts.isRetryable(err) : true;
      if (!retryable || attempt === opts.attempts - 1) throw err;
      const delay = backoffDelayMs(attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, label = 'operation'): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`circuit "${name}" is open`);
    this.name = 'CircuitOpenError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half_open';

/**
 * Consecutive-failure circuit breaker. closed → (threshold failures) → open → (cooldown) → half_open
 * → one probe: success closes, failure re-opens. Prevents a slow dependency from consuming every worker/request.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';
  private probing = false;

  constructor(
    public readonly name: string,
    private readonly opts: { failureThreshold: number; cooldownMs: number; now?: () => number; onStateChange?: (s: CircuitState) => void },
  ) {}

  private now = () => (this.opts.now ? this.opts.now() : Date.now());

  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) this.transition('half_open');
    return this.state;
  }

  private transition(s: CircuitState) {
    if (this.state !== s) {
      this.state = s;
      this.opts.onStateChange?.(s);
    }
  }

  async exec<T>(fn: () => Promise<T>, isFailure: (e: unknown) => boolean = () => true): Promise<T> {
    const state = this.getState();
    if (state === 'open') throw new CircuitOpenError(this.name);
    if (state === 'half_open') {
      if (this.probing) throw new CircuitOpenError(this.name);
      this.probing = true;
    }
    try {
      const out = await fn();
      this.failures = 0;
      this.probing = false;
      this.transition('closed');
      return out;
    } catch (err) {
      if (isFailure(err)) {
        this.failures++;
        this.probing = false;
        if (state === 'half_open' || this.failures >= this.opts.failureThreshold) {
          this.openedAt = this.now();
          this.transition('open');
        }
      } else {
        this.probing = false;
      }
      throw err;
    }
  }
}
