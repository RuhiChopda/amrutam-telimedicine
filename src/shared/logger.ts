import { trace } from '@opentelemetry/api';
import pino, { Logger } from 'pino';
import { currentContext } from './context';

export type { Logger };

/**
 * Structured JSON logs. Every line carries requestId / traceId / userId from the ambient context so a single request can
 * be followed across API, worker and DB spans. Secrets and PII are redacted at the serializer level (defence in depth:
 * the code also avoids logging bodies at all).
 */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'mfaToken',
  'code',
  'recoveryCode',
  'secret',
  'clientSecret',
  'authorization',
  'cookie',
  'email',
  'phone',
  'fullName',
  'dateOfBirth',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.clientSecret',
  '*.authorization',
  '*.email',
  '*.phone',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
];

export function createLogger(opts: { level: string; service: string; destination?: pino.DestinationStream }): Logger {
  return pino(
    {
      level: opts.level,
      base: { service: opts.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: { level: (label) => ({ level: label }) },
      mixin() {
        const ctx = currentContext();
        const span = trace.getActiveSpan()?.spanContext();
        return {
          ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
          ...(ctx?.actor ? { userId: ctx.actor.id, role: ctx.actor.role } : {}),
          ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
        };
      },
    },
    opts.destination,
  );
}
