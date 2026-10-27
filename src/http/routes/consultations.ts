import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container';
import { bookSchema, cancelSchema, listConsultationsSchema } from '../../modules/consultations/booking';
import { completeSchema, listPrescriptionsSchema, prescriptionSchema, reviewSchema } from '../../modules/consultations/lifecycle';
import { parse, uuid } from '../../shared/validation';
import { idempotencyKeyOf, type Guards } from '../app';

export async function consultationRoutes(app: FastifyInstance, c: Container, g: Guards) {
  const write = g.limit('write', c.cfg.rateLimit.writePerMin);
  const idParam = (req: { params: unknown }) => parse(uuid, (req.params as { id: string }).id);

  // Booking: Idempotency-Key REQUIRED. Retrying with the same key returns the original response (no second booking).
  app.post('/consultations', { preHandler: [g.auth({ permission: 'booking:create' }), write] }, async (req, reply) => {
    const body = parse(bookSchema, req.body);
    const key = idempotencyKeyOf(req);
    const out = await c.idempotency.run({ userId: req.actor!.id, key, method: 'POST', path: '/v1/consultations', body }, (tx) => c.booking.book(req.actor!, body, tx));
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    reply.status(out.status);
    return out.body;
  });

  app.get('/consultations', { preHandler: g.auth({ permission: 'consultation:read' }) }, async (req) =>
    c.booking.list(req.actor!, parse(listConsultationsSchema, req.query)),
  );
  app.get('/consultations/:id', { preHandler: g.auth({ permission: 'consultation:read' }) }, async (req) => c.booking.get(req.actor!, idParam(req)));

  app.post('/consultations/:id/cancel', { preHandler: [g.auth({ permission: 'consultation:cancel' }), write] }, async (req) =>
    c.booking.cancel(req.actor!, idParam(req), parse(cancelSchema, req.body ?? {}).reason),
  );
  app.post('/consultations/:id/start', { preHandler: [g.auth({ permission: 'consultation:start' }), write] }, async (req) => c.lifecycle.start(req.actor!, idParam(req)));
  app.post('/consultations/:id/complete', { preHandler: [g.auth({ permission: 'consultation:complete' }), write] }, async (req) =>
    c.lifecycle.complete(req.actor!, idParam(req), parse(completeSchema, req.body ?? {}).notes),
  );
  app.post('/consultations/:id/review', { preHandler: [g.auth({ permission: 'review:create' }), write] }, async (req, reply) => {
    reply.status(201);
    return c.lifecycle.review(req.actor!, idParam(req), parse(reviewSchema, req.body));
  });

  app.post('/consultations/:id/prescriptions', { preHandler: [g.auth({ permission: 'prescription:create' }), write] }, async (req, reply) => {
    const body = parse(prescriptionSchema, req.body);
    const id = idParam(req);
    const out = await c.idempotency.run(
      { userId: req.actor!.id, key: idempotencyKeyOf(req), method: 'POST', path: `/v1/consultations/${id}/prescriptions`, body },
      (tx) => c.lifecycle.createPrescription(req.actor!, id, body, tx),
    );
    if (out.replayed) reply.header('Idempotent-Replayed', 'true');
    reply.status(out.status);
    return out.body;
  });
  app.get('/consultations/:id/prescriptions', { preHandler: g.auth({ permission: 'prescription:read' }) }, async (req) =>
    c.lifecycle.listForConsultation(req.actor!, idParam(req)),
  );

  app.get('/prescriptions', { preHandler: g.auth({ permission: 'prescription:read' }) }, async (req) =>
    c.lifecycle.listMine(req.actor!, parse(listPrescriptionsSchema, req.query)),
  );
  app.get('/prescriptions/:id', { preHandler: g.auth({ permission: 'prescription:read' }) }, async (req) => c.lifecycle.getPrescription(req.actor!, idParam(req)));
}
