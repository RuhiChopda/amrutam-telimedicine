import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Container } from '../../container';
import { availabilitySchema, doctorUpdateSchema, searchSchema, slotsQuerySchema } from '../../modules/doctors/service';
import { isoDateTime, parse, uuid } from '../../shared/validation';
import type { Guards } from '../app';

export async function doctorRoutes(app: FastifyInstance, c: Container, g: Guards) {
  const write = g.limit('write', c.cfg.rateLimit.writePerMin);

  // Public search is unauthenticated (marketing/SEO use) but rate limited by IP and cached.
  app.get('/doctors', async (req) => c.doctors.search(parse(searchSchema, req.query)));

  // Doctor self-service (declared before /doctors/:id; static segments win in the router regardless).
  app.get('/doctors/me', { preHandler: g.auth({ permission: 'doctor:profile:manage' }) }, async (req) => c.doctors.getSelf(req.actor!.id));
  app.patch('/doctors/me', { preHandler: [g.auth({ permission: 'doctor:profile:manage' }), write] }, async (req) =>
    c.doctors.updateSelf(req.actor!.id, parse(doctorUpdateSchema, req.body)),
  );
  app.post('/doctors/me/availability', { preHandler: [g.auth({ permission: 'availability:manage' }), write] }, async (req, reply) => {
    reply.status(201);
    return c.doctors.createAvailability(req.actor!.id, parse(availabilitySchema, req.body));
  });
  app.get('/doctors/me/slots', { preHandler: g.auth({ permission: 'availability:manage' }) }, async (req) => {
    const q = parse(z.strictObject({ from: isoDateTime, to: isoDateTime }), req.query);
    return c.doctors.listOwnSlots(req.actor!.id, new Date(q.from), new Date(q.to));
  });
  app.delete('/doctors/me/slots/:slotId', { preHandler: [g.auth({ permission: 'availability:manage' }), write] }, async (req, reply) => {
    await c.doctors.cancelOwnSlot(req.actor!.id, parse(uuid, (req.params as { slotId: string }).slotId));
    reply.status(204);
  });

  app.get('/doctors/:id', async (req) => c.doctors.getPublic(parse(uuid, (req.params as { id: string }).id)));
  app.get('/doctors/:id/slots', async (req) =>
    c.doctors.listOpenSlots(parse(uuid, (req.params as { id: string }).id), parse(slotsQuerySchema, req.query)),
  );
}
