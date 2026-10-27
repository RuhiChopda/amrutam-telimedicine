import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { analyticsQuerySchema } from '../../modules/admin/analytics';
import { verificationSchema } from '../../modules/doctors/service';
import { cursorSchema, decodeCursor, encodeCursor, isoDateTime, limitSchema, parse, uuid } from '../../shared/validation';
import type { Guards } from '../app';

const auditQuery = z.strictObject({
  actorId: uuid.optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(64).optional(),
  action: z.string().max(80).optional(),
  outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: limitSchema,
  cursor: cursorSchema,
});

export async function adminRoutes(app: FastifyInstance, c: Container, g: Guards) {
  const write = g.limit('write', c.cfg.rateLimit.writePerMin);
  const id = (req: { params: unknown }) => parse(uuid, (req.params as { id: string }).id);

  app.get('/admin/doctors', { preHandler: g.auth({ permission: 'admin:doctors:verify' }) }, async (req) => {
    const q = parse(z.strictObject({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED']).optional(), limit: limitSchema, cursor: cursorSchema }), req.query);
    return c.doctors.adminList(q.status, q.limit, q.cursor);
  });
  app.post('/admin/doctors/:id/verification', { preHandler: [g.auth({ permission: 'admin:doctors:verify' }), write] }, async (req) =>
    c.doctors.adminVerify(req.actor!.id, id(req), parse(verificationSchema, req.body)),
  );

  app.post('/admin/users/:id/suspend', { preHandler: [g.auth({ permission: 'admin:users:manage' }), write] }, async (req, reply) => {
    await c.auth.setUserStatus(req.actor!, id(req), 'SUSPENDED');
    reply.status(204);
  });
  app.post('/admin/users/:id/activate', { preHandler: [g.auth({ permission: 'admin:users:manage' }), write] }, async (req, reply) => {
    await c.auth.setUserStatus(req.actor!, id(req), 'ACTIVE');
    reply.status(204);
  });
  app.post('/admin/users/:id/mfa-reset', { preHandler: [g.auth({ permission: 'admin:users:manage' }), write] }, async (req, reply) => {
    await c.auth.resetMfa(req.actor!, id(req));
    reply.status(204);
  });

  // Admin may cancel any consultation (e.g. doctor emergency) but never reads clinical content.
  app.post('/admin/consultations/:id/cancel', { preHandler: [g.auth({ permission: 'consultation:cancel:any' }), write] }, async (req) =>
    c.booking.cancel(req.actor!, id(req), 'Cancelled by administrator'),
  );

  app.get('/admin/analytics/summary', { preHandler: g.auth({ permission: 'admin:analytics:read' }) }, async (req) =>
    c.analytics.summary(parse(analyticsQuerySchema, req.query)),
  );

  app.get('/admin/audit-logs', { preHandler: g.auth({ permission: 'admin:audit:read' }) }, async (req) => {
    const q = parse(auditQuery, req.query);
    const cursor = decodeCursor(q.cursor, z.strictObject({ createdAt: z.string().datetime(), id: z.number().int() }));
    // reading the audit log is itself audited
    await c.audit.recordStandalone({ action: 'audit.read', entityType: 'audit_logs', metadata: { filters: Object.keys(q).filter((k) => k !== 'cursor' && k !== 'limit') } });
    const r = await c.audit.list({ ...q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined, cursor });
    return { items: r.items, nextCursor: r.next ? encodeCursor(r.next) : undefined };
  });
  app.post('/admin/audit-logs/verify', { preHandler: g.auth({ permission: 'admin:audit:read' }) }, async (req) => {
    const q = parse(z.strictObject({ from: isoDateTime, to: isoDateTime }), req.body);
    return c.audit.verify(new Date(q.from), new Date(q.to));
  });

  app.get('/admin/jobs/dead', { preHandler: g.auth({ permission: 'admin:jobs:manage' }) }, async () => c.admin.deadJobs());
  app.post('/admin/jobs/:id/requeue', { preHandler: [g.auth({ permission: 'admin:jobs:manage' }), write] }, async (req, reply) => {
    await c.admin.requeueJob(id(req));
    reply.status(204);
  });
}
