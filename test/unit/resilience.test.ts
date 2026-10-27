import { describe, expect, it, vi } from 'vitest';
import { jobRetryDelayMs } from '../../src/modules/jobs/queue';
import { backoffDelayMs, CircuitBreaker, CircuitOpenError, retry, TimeoutError, withTimeout } from '../../src/shared/retry';

describe('backoff', () => {
  it('grows exponentially with full jitter and respects the cap', () => {
    const o = { baseMs: 100, capMs: 1000 };
    expect(backoffDelayMs(0, { ...o, random: () => 0.999 })).toBeLessThan(100);
    expect(backoffDelayMs(2, { ...o, random: () => 0.999 })).toBeLessThan(400);
    expect(backoffDelayMs(10, { ...o, random: () => 0.999 })).toBeLessThan(1000);
    expect(backoffDelayMs(3, { ...o, random: () => 0 })).toBe(0);
  });
  it('job retry delay has a guaranteed minimum (equal jitter) and a cap', () => {
    expect(jobRetryDelayMs(1, () => 0)).toBe(1000);
    expect(jobRetryDelayMs(3, () => 0)).toBe(4000);
    expect(jobRetryDelayMs(30, () => 0.9999)).toBeLessThanOrEqual(300_000);
  });
});

describe('retry', () => {
  it('retries retryable errors and then succeeds', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const out = await retry(async () => { if (++n < 3) throw new Error('boom'); return 'ok'; }, { attempts: 5, baseMs: 10, capMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    expect(out).toBe('ok');
    expect(n).toBe(3);
    expect(sleeps).toHaveLength(2);
  });
  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new Error('fatal'); }, { attempts: 5, baseMs: 1, capMs: 1, isRetryable: () => false })).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });
  it('gives up after the attempt budget', async () => {
    let n = 0;
    await expect(retry(async () => { n++; throw new Error('x'); }, { attempts: 3, baseMs: 1, capMs: 1, sleep: async () => undefined })).rejects.toThrow('x');
    expect(n).toBe(3);
  });
});

describe('withTimeout', () => {
  it('rejects slow operations and aborts the signal', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const p = withTimeout((signal) => new Promise((r) => { signal.addEventListener('abort', () => { aborted = true; }); setTimeout(r, 10_000); }), 100, 'slow');
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, fails fast, half-opens after cooldown, and closes on a successful probe', async () => {
    let now = 0;
    const states: string[] = [];
    const cb = new CircuitBreaker('t', { failureThreshold: 3, cooldownMs: 1000, now: () => now, onStateChange: (s) => states.push(s) });
    const fail = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toThrow('down');
    await expect(cb.exec(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
    now = 1500;
    expect(cb.getState()).toBe('half_open');
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    expect(cb.getState()).toBe('closed');
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });
  it('re-opens if the half-open probe fails, and ignores non-failure errors', async () => {
    let now = 0;
    const cb = new CircuitBreaker('t', { failureThreshold: 1, cooldownMs: 100, now: () => now });
    await expect(cb.exec(() => Promise.reject(new Error('a')))).rejects.toThrow();
    now = 200;
    await expect(cb.exec(() => Promise.reject(new Error('b')))).rejects.toThrow('b');
    expect(cb.getState()).toBe('open');
    const cb2 = new CircuitBreaker('t2', { failureThreshold: 1, cooldownMs: 100 });
    await expect(cb2.exec(() => Promise.reject(new Error('biz')), () => false)).rejects.toThrow();
    expect(cb2.getState()).toBe('closed');
  });
});
