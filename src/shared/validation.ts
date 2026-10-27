import { z } from 'zod';
import { badRequest } from './errors';

export const uuid = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12, 'password must be at least 12 characters').max(128);
export const isoDateTime = z.string().datetime({ offset: true });
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_\-:.]{8,128}$/, 'Idempotency-Key must be 8-128 chars [A-Za-z0-9_-:.]');
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
export const cursorSchema = z.string().max(512).optional();
export const shortText = (max: number) => z.string().trim().min(1).max(max);

/** Parse unknown input with a zod schema, translating failures into a 400 problem response. */
export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Request validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    );
  }
  return r.data;
}

/** Opaque, URL-safe keyset-pagination cursors. Contents are validated on decode and only ever used as bind parameters. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<S extends z.ZodTypeAny>(cursor: string | undefined, schema: S): z.infer<S> | undefined {
  if (!cursor) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw badRequest('INVALID_CURSOR', 'Pagination cursor is invalid');
  }
}
