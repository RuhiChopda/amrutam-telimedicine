import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container';
import { signWebhook } from '../../modules/payments/gateway';
import { notFound, unauthorized } from '../../shared/errors';
import { parse, uuid } from '../../shared/validation';
import type { Guards } from '../app';

export async function paymentRoutes(app: FastifyInstance, c: Container, g: Guards) {
  app.get('/payments/:id', { preHandler: g.auth({ permission: 'payment:read' }) }, async (req) =>
    c.payments.getForPatient(req.actor!, parse(uuid, (req.params as { id: string }).id)),
  );

  // PSP → us. Authenticated by HMAC signature over the raw body (+ timestamp replay window), not by bearer token.
  // Deduplicated by event id, so provider retries are harmless.
  app.post('/webhooks/payments', async (req) => {
    const sig = req.headers['x-webhook-signature'];
    return c.payments.handleWebhook(req.rawBody ?? '', typeof sig === 'string' ? sig : undefined);
  });

  if (c.cfg.devEndpoints) {
    // Local/demo only (refused in production by config validation): stands in for the PSP calling the webhook.
    app.post('/dev/payments/:id/simulate', { preHandler: g.auth() }, async (req) => {
      const id = parse(uuid, (req.params as { id: string }).id);
      const { outcome = 'succeeded', eventId } = (req.body ?? {}) as { outcome?: string; eventId?: string };
      const p = (await c.db.query<{ patient_id: string; provider_ref: string | null }>('SELECT patient_id, provider_ref FROM payments WHERE id = $1', [id])).rows[0];
      if (!p) throw notFound('Payment');
      if (p.patient_id !== req.actor!.id) throw unauthorized('Not your payment');
      const body = JSON.stringify({
        id: eventId ?? `evt_${randomUUID()}`,
        type: outcome === 'failed' ? 'payment.failed' : 'payment.succeeded',
        data: { paymentId: id, providerRef: p.provider_ref ?? undefined, failureCode: outcome === 'failed' ? 'card_declined' : undefined },
      });
      return c.payments.handleWebhook(body, signWebhook(c.cfg.payments.webhookSecret, body));
    });
  }
}
