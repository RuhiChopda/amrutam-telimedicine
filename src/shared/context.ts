import { AsyncLocalStorage } from 'node:async_hooks';

export type Role = 'patient' | 'doctor' | 'admin' | 'auditor';

export interface Actor {
  id: string;
  role: Role;
  sessionId: string;
  /** Authentication methods references: 'pwd', 'otp'. */
  amr: string[];
}

export interface RequestContext {
  requestId: string;
  ip?: string;
  userAgent?: string;
  traceId?: string;
  actor?: Actor;
}

/**
 * Per-request (or per-job) ambient context. Used for audit enrichment and log correlation so that services do not
 * need to thread HTTP details through every call. Services still receive the Actor explicitly for authorization.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentContext = (): RequestContext | undefined => requestContext.getStore();
