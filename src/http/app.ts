import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Container } from '../container';
import { can, type Permission } from '../modules/auth/rbac';
import { requestContext, type Actor, type RequestContext } from '../shared/context';
import { AppError, tooMany, unauthorized, forbidden } from '../shared/errors';
import { pgCode, PG } from '../shared/errors';
import { currentTraceId } from '../shared/telemetry';
import { authRoutes } from './routes/auth';
import { consultationRoutes } from './routes/consultations';
import { doctorRoutes } from './routes/doctors';
import { adminRoutes } from './routes/admin';
import { paymentRoutes } from './routes/payments';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    rawBody?: string;
    ctx?: RequestContext;
    startNs?: bigint;
  }
  interface FastifyInstance {
    /** every registered route as `METHOD /pattern` (used by the OpenAPI drift check) */
    routeTable: string[];
  }
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

export interface Guards {
  /** Requires a valid access token (and satisfied MFA for privileged roles unless `allowPreMfa`). */
  auth(opts?: { permission?: Permission; allowPreMfa?: boolean }): (req: FastifyRequest) => Promise<void>;
  /** Per-actor/IP rate limit for a scope. */
  limit(scope: string, perMin: number): (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export async function buildApp(c: Container): Promise<FastifyInstance> {
  const { cfg, logger, metrics } = c;
  const app = Fastify({
    logger: false,
    trustProxy: cfg.trustProxy,
    bodyLimit: 256 * 1024,
    requestTimeout: 15_000,
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
    ajv: { customOptions: { removeAdditional: false } },
  });

  const routeTable: string[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== 'HEAD' && m !== 'OPTIONS') routeTable.push(`${m} ${r.url}`);
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, hsts: { maxAge: 31536000, includeSubDomains: true } });
  await app.register(cors, { origin: cfg.corsOrigins.length ? cfg.corsOrigins : false, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'], maxAge: 600 });

  // Keep the raw body (needed to verify webhook HMAC) while still parsing JSON strictly.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!(body as string).length) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON'), undefined);
    }
  });

  /* ---- request context, correlation, timing, metrics ---- */
  app.addHook('onRequest', (req, reply, done) => {
    const ctx: RequestContext = { requestId: req.id, ip: req.ip, userAgent: req.headers['user-agent'], traceId: currentTraceId() };
    req.ctx = ctx;
    req.startNs = process.hrtime.bigint();
    metrics.httpInFlight.inc();
    reply.header('X-Request-Id', req.id);
    reply.header('Cache-Control', 'no-store');
    requestContext.run(ctx, done);
  });

  app.addHook('onResponse', (req, reply, done) => {
    metrics.httpInFlight.dec();
    const route = req.routeOptions?.url ?? 'unmatched';
    const seconds = Number(process.hrtime.bigint() - (req.startNs ?? 0n)) / 1e9;
    metrics.httpDuration.observe({ method: req.method, route, status_class: `${Math.floor(reply.statusCode / 100)}xx` }, seconds);
    if (route !== '/healthz' && route !== '/readyz') {
      logger.info({ method: req.method, route, status: reply.statusCode, ms: Math.round(seconds * 1000), requestId: req.id, userId: req.actor?.id }, 'request');
    }
    done();
  });

  /* ---- global IP rate limit (cheap, before any work) ---- */
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url === '/readyz') return;
    const r = await c.rateLimiter.hit('global', req.ip, cfg.rateLimit.globalPerMin, 60);
    reply.header('RateLimit-Limit', String(r.limit)).header('RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) throw tooMany(r.retryAfterSeconds);
  });

  /* ---- guards ---- */
  const guards: Guards = {
    auth: (opts = {}) =>
      async (req) => {
        const h = req.headers.authorization;
        if (!h || !h.startsWith('Bearer ')) throw unauthorized();
        const actor = await c.auth.verifyAccessToken(h.slice(7).trim());
        req.actor = actor;
        if (req.ctx) req.ctx.actor = actor;
        if (!opts.allowPreMfa) await c.auth.assertMfaSatisfied(actor);
        if (opts.permission && !can(actor.role, opts.permission)) {
          await c.audit.recordStandalone({ action: 'authz.denied', outcome: 'DENIED', metadata: { permission: opts.permission, path: req.routeOptions?.url } });
          throw forbidden();
        }
      },
    limit: (scope, perMin) =>
      async (req, reply) => {
        const key = req.actor?.id ?? req.ip;
        const r = await c.rateLimiter.hit(scope, key, perMin, 60);
        if (!r.allowed) {
          reply.header('Retry-After', String(r.retryAfterSeconds));
          throw tooMany(r.retryAfterSeconds);
        }
      },
  };

  /* ---- errors: RFC 7807 problem+json; never leak internals ---- */
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, req, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;
    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
      for (const [k, v] of Object.entries(err.headers ?? {})) reply.header(k, v);
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'VALIDATION_FAILED';
      message = 'Request validation failed';
      details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    } else if ((err as FastifyError).statusCode && (err as FastifyError).statusCode! < 500) {
      status = (err as FastifyError).statusCode!;
      code = status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST';
      message = status === 413 ? 'Request body too large' : status === 415 ? 'Content-Type must be application/json' : 'Bad request';
    } else if (pgCode(err) === PG.QUERY_CANCELED) {
      status = 503;
      code = 'DB_TIMEOUT';
      message = 'The service is busy; please retry';
      reply.header('Retry-After', '2');
    } else if (pgCode(err) === PG.LOCK_NOT_AVAILABLE || pgCode(err) === PG.SERIALIZATION_FAILURE || pgCode(err) === PG.DEADLOCK) {
      status = 409;
      code = 'CONFLICT_RETRY';
      message = 'Concurrent update; please retry';
    }
    if (status >= 500) logger.error({ err, requestId: req.id, route: req.routeOptions?.url }, 'unhandled error');
    reply.status(status).type('application/problem+json').send({
      type: `https://api.amrutam.example/problems/${code.toLowerCase()}`,
      title: code,
      status,
      code,
      detail: message,
      requestId: req.id,
      ...(details !== undefined ? { errors: details } : {}),
    });
  });
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/problem+json').send({ type: 'about:blank', title: 'NOT_FOUND', status: 404, code: 'NOT_FOUND', detail: 'Route not found', requestId: req.id });
  });

  /* ---- health ---- */
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const dbOk = await c.db.healthy();
    // Redis is optional (degraded mode), so it never fails readiness; the DB does.
    reply.status(dbOk ? 200 : 503);
    return { status: dbOk ? 'ready' : 'not_ready', db: dbOk, redis: c.redis ? c.redis.status === 'ready' : 'disabled' };
  });

  /* ---- routes ---- */
  await app.register(async (v1) => {
    await authRoutes(v1, c, guards);
    await doctorRoutes(v1, c, guards);
    await consultationRoutes(v1, c, guards);
    await paymentRoutes(v1, c, guards);
    await adminRoutes(v1, c, guards);
  }, { prefix: '/v1' });

  return app;
}

export const idempotencyKeyOf = (req: FastifyRequest): string => {
  const k = req.headers['idempotency-key'];
  if (typeof k !== 'string') throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required for this operation');
  if (!/^[A-Za-z0-9_\-:.]{8,128}$/.test(k)) throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.]');
  return k;
};
