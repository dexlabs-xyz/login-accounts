/**
 * Sending email. Shared: any component may send through the configured Mailer.
 * Hosted: Resend (team decision 2026-11-04). Development: an in-memory outbox.
 */

export interface OutboxEmail {
  to: string;
  subject: string;
  /** Plain text. Always sent; it's what text-only email apps show. */
  body: string;
  /** Optional designed version. Email apps that can show HTML show this instead of `body`. */
  html?: string;
  sentAt: number;
}

export interface Mailer {
  send(email: Omit<OutboxEmail, 'sentAt'>): Promise<void>;
}

/**
 * Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email),
 * called with fetch: no SDK. The email address and message go to Resend, an
 * email provider; nothing else does. The API key is a secret from the host's
 * settings and is never logged.
 */
export function resendMailer(opts: { apiKey: string; from: string; fetch?: typeof fetch }): Mailer {
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    async send(email) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: opts.from,
          to: [email.to],
          subject: email.subject,
          text: email.body,
          ...(email.html ? { html: email.html } : {}),
        }),
      });
      // Status only: Resend's error body could echo the address.
      if (!res.ok) throw new Error(`Email provider refused the message (${res.status}).`);
    },
  };
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
