import type { Logger } from '../../shared/logger';

export interface Notification {
  userId: string;
  template: string;
  data?: Record<string, unknown>;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
}

/**
 * Development notifier: logs that a notification would be sent (template + recipient id only — no PII, no content).
 * Production swaps in an SES/SNS/FCM adapter; delivery runs in the worker with retries, so channel outages never block
 * the booking path.
 */
export class LogNotifier implements Notifier {
  readonly sent: Notification[] = [];
  constructor(private readonly logger: Logger) {}
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
    if (this.sent.length > 1000) this.sent.shift();
    this.logger.info({ notification: { userId: n.userId, template: n.template } }, 'notification dispatched');
  }
}
