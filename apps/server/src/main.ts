import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { devOutboxMailer, type Mailer, type OutboxEmail } from './mail.ts';
import { ethersGasSender } from './testnet-gas/sender.ts';

const config = loadConfig();
const outbox: OutboxEmail[] = [];

let mailer: Mailer;
if (config.devOutbox) {
  mailer = devOutboxMailer(outbox);
} else {
  // Resend will plug in here (team decision 2026-11-04). Until then, only the dev outbox exists.
  throw new Error('No email provider configured. Set DEV_OUTBOX=1 for local development.');
}

// TESTNET-ONLY gas faucet: on only when its key is set. Contradicts D6; never on mainnet.
const faucetKey = process.env.TESTNET_GAS_FAUCET_KEY;
const gasSender = faucetKey
  ? ethersGasSender(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', faucetKey)
  : null;

const { app } = createApp({ config, db: openDb(config.dbPath), mailer, outbox, gasSender });

serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, ({ port }) => {
  console.log(`Login API on http://127.0.0.1:${port} (RP ID: ${config.rpId})`);
  if (config.devOutbox) console.log('Dev outbox on: email codes are shown at /dev/outbox.');
  console.log(
    gasSender
      ? 'TESTNET gas faucet ON (simulation, Sepolia only; contradicts D6, never on mainnet).'
      : 'Testnet gas faucet off (set TESTNET_GAS_FAUCET_KEY to enable).',
  );
});
