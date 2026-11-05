/**
 * Sending email. Shared: any component may send through the configured Mailer.
 * Resend will plug in here; development uses an in-memory outbox.
 */

export interface OutboxEmail {
  to: string;
  subject: string;
  body: string;
  sentAt: number;
}

export interface Mailer {
  send(email: Omit<OutboxEmail, 'sentAt'>): Promise<void>;
}

/** Development only: keeps the last 50 emails in memory for /dev/outbox. */
export function devOutboxMailer(outbox: OutboxEmail[]): Mailer {
  return {
    async send(email) {
      outbox.unshift({ ...email, sentAt: Date.now() });
      outbox.length = Math.min(outbox.length, 50);
    },
  };
}
