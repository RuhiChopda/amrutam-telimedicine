import { z } from 'zod';
import { AAD } from '../../shared/aad';
import type { Clock } from '../../shared/clock';
import type { FieldCrypto } from '../../shared/crypto';
import type { Db } from '../../shared/db';
import { badRequest, forbidden, notFound, PermanentJobError } from '../../shared/errors';
import type { Metrics } from '../../shared/metrics';
import type { Actor } from '../../shared/context';
import type { AuditService } from '../audit/service';
import type { BookingService, PaymentRow } from '../consultations/booking';
import type { JobQueue } from '../jobs/queue';
import { verifyWebhookSignature, type PaymentGateway } from './gateway';

export const webhookSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(['payment.succeeded', 'payment.failed']),
  data: z.object({ paymentId: z.string().uuid(), providerRef: z.string().max(128).optional(), failureCode: z.string().max(64).optional() }),
});

/** PSP-facing side of the saga: job handlers that call the gateway, and the webhook entry point. */
export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly gateway: PaymentGateway,
    private readonly booking: BookingService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly crypto: FieldCrypto,
    private readonly webhookSecret: string,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  /* ---------------------------------------------------------------- webhook */
  async handleWebhook(rawBody: string, signatureHeader: string | undefined): Promise<{ received: true; duplicate?: boolean }> {
    if (!verifyWebhookSignature(this.webhookSecret, rawBody, signatureHeader)) {
      await this.audit.recordStandalone({ action: 'payment.webhook', outcome: 'DENIED', actorRole: 'webhook', metadata: { reason: 'bad_signature' } });
      throw forbidden('Invalid webhook signature', 'INVALID_SIGNATURE');
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw badRequest('INVALID_JSON', 'Webhook body is not valid JSON');
    }
    const ev = webhookSchema.safeParse(json);
    if (!ev.success) throw badRequest('INVALID_WEBHOOK', 'Unrecognised webhook payload');
    const { id, type, data } = ev.data;
    if (type === 'payment.succeeded') await this.booking.onPaymentSucceeded(data.paymentId, data.providerRef, id);
    else await this.booking.onPaymentFailed(data.paymentId, data.failureCode, id);
    return { received: true };
  }

  /* ---------------------------------------------------------------- job handlers */
  /** payment.create_intent — idempotent at the PSP via the payment id as idempotency key. */
  async createIntent(paymentId: string): Promise<void> {
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
    const p = rows[0];
    if (!p) throw new PermanentJobError(`payment ${paymentId} not found`);
    if (p.status !== 'PENDING') return; // paid/expired/voided already

    const intent = await this.gateway.createIntent({
      idempotencyKey: `intent:${paymentId}`,
      amountMinor: p.amount_minor,
      currency: p.currency.trim(),
      metadata: { paymentId, consultationId: p.consultation_id },
    });
    await this.db.tx(async (tx) => {
      const cur = (await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId])).rows[0];
      if (!cur) return;
      if (cur.status === 'PENDING') {
        await tx.query(`UPDATE payments SET status = 'REQUIRES_PAYMENT', provider_ref = $2, client_secret_enc = $3 WHERE id = $1`, [
          paymentId,
          intent.providerRef,
          this.crypto.encrypt(intent.clientSecret, AAD.paymentSecret(paymentId)),
        ]);
        this.metrics.payments.inc({ event: 'intent_created' });
      } else if (cur.status === 'VOIDED' || cur.status === 'FAILED') {
        // The booking expired while the PSP call was in flight: record the ref and compensate by voiding the intent.
        await tx.query('UPDATE payments SET provider_ref = coalesce(provider_ref, $2) WHERE id = $1', [paymentId, intent.providerRef]);
        await this.queue.enqueue(tx, 'payment.void', { paymentId }, { dedupeKey: `void:${paymentId}` });
      }
    });
  }

  async voidIntent(paymentId: string): Promise<void> {
    const p = (await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId])).rows[0];
    if (!p || !p.provider_ref) return; // nothing was created at the PSP
    await this.gateway.voidIntent(p.provider_ref, `void:${paymentId}`);
    await this.audit.recordStandalone({ action: 'payment.voided', actorRole: 'system', entityType: 'payment', entityId: paymentId });
    this.metrics.payments.inc({ event: 'voided' });
  }

  async refund(paymentId: string): Promise<void> {
    const p = (await this.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId])).rows[0];
    if (!p) throw new PermanentJobError(`payment ${paymentId} not found`);
    if (p.status !== 'REFUND_PENDING') return; // already refunded (job retried after success)
    if (!p.provider_ref || !p.refund_amount_minor) throw new PermanentJobError(`payment ${paymentId} is not refundable`);
    const r = await this.gateway.refund({ providerRef: p.provider_ref, amountMinor: p.refund_amount_minor, idempotencyKey: `refund:${paymentId}` });
    await this.db.tx(async (tx) => {
      await tx.query(`UPDATE payments SET status = 'REFUNDED', refund_ref = $2, refunded_at = $3 WHERE id = $1 AND status = 'REFUND_PENDING'`, [
        paymentId,
        r.refundRef,
        this.clock.now(),
      ]);
      await this.audit.record(tx, { action: 'payment.refunded', actorRole: 'system', actorId: null, entityType: 'payment', entityId: paymentId, metadata: { amountMinor: p.refund_amount_minor } });
      await this.queue.enqueue(tx, 'notify', { userId: p.patient_id, template: 'payment.refunded', data: { paymentId } });
    });
    this.metrics.payments.inc({ event: 'refunded' });
  }

  /* ---------------------------------------------------------------- reads */
  async getForPatient(actor: Actor, paymentId: string) {
    const p = (await this.db.query<PaymentRow & { paid_at: Date | null }>('SELECT * FROM payments WHERE id = $1 AND patient_id = $2', [paymentId, actor.id])).rows[0];
    if (!p) throw notFound('Payment');
    return {
      id: p.id,
      consultationId: p.consultation_id,
      status: p.status,
      amount: { amountMinor: p.amount_minor, currency: p.currency.trim() },
      refundAmountMinor: p.refund_amount_minor,
      clientSecret:
        p.status === 'REQUIRES_PAYMENT' && p.client_secret_enc ? this.crypto.decrypt(p.client_secret_enc, AAD.paymentSecret(p.id)) : undefined,
      expiresAt: p.expires_at?.toISOString() ?? null,
    };
  }
}
