export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock: starts at a fixed instant and only moves when told to. */
export class FakeClock implements Clock {
  constructor(private current: Date = new Date()) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date): void {
    this.current = new Date(d);
  }
}

export const addSeconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);
export const addMinutes = (d: Date, m: number) => addSeconds(d, m * 60);
export const addHours = (d: Date, h: number) => addMinutes(d, h * 60);
export const addDays = (d: Date, n: number) => addHours(d, n * 24);
