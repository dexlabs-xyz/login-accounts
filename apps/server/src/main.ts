import { serve } from '@hono/node-server';
import { createApp, devOutboxMailer, type Mailer, type OutboxEmail } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';

const config = loadConfig();
const outbox: OutboxEmail[] = [];

let mailer: Mailer;
if (config.devOutbox) {
  mailer = devOutboxMailer(outbox);
} else {
  // Resend will plug in here (team decision 2026-11-04). Until then, only the dev outbox exists.
  throw new Error('No email provider configured. Set DEV_OUTBOX=1 for local development.');
}

const app = createApp({ config, db: openDb(config.dbPath), mailer, outbox });

serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, ({ port }) => {
  console.log(`Login API on http://127.0.0.1:${port} (RP ID: ${config.rpId})`);
  if (config.devOutbox) console.log('Dev outbox on: email codes are shown at /dev/outbox.');
});
