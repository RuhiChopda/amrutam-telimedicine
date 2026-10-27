/** Application error carried to the HTTP layer as RFC 7807 problem+json. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Authentication required', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, msg, undefined, { 'WWW-Authenticate': 'Bearer' });
export const forbidden = (msg = 'You do not have access to this resource', code = 'FORBIDDEN') =>
  new AppError(403, code, msg);
export const notFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
export const tooMany = (retryAfterSeconds: number, msg = 'Too many requests') =>
  new AppError(429, 'RATE_LIMITED', msg, undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });

/** Thrown by job handlers for failures that must not be retried (goes straight to the dead-letter state). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Postgres SQLSTATE helpers. */
export const PG = {
  UNIQUE_VIOLATION: '23505',
  EXCLUSION_VIOLATION: '23P01',
  FOREIGN_KEY_VIOLATION: '23503',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
} as const;

export const pgCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
