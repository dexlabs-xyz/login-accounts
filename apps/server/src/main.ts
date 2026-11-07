import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { loadKycConfig } from './kyc/config.ts';
import { createSumsubClient } from './kyc/sumsub.ts';
import { devOutboxMailer, resendMailer, type Mailer, type OutboxEmail } from './mail.ts';
import { ethersGasSender } from './testnet-gas/sender.ts';

const config = loadConfig();
const outbox: OutboxEmail[] = [];

let mailer: Mailer;
if (config.devOutbox) {
  mailer = devOutboxMailer(outbox);
} else if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
  mailer = resendMailer({ apiKey: process.env.RESEND_API_KEY, from: process.env.MAIL_FROM });
} else {
  throw new Error('No email provider configured. Set RESEND_API_KEY and MAIL_FROM, or DEV_OUTBOX=1 for local development.');
}

const kycConfig = loadKycConfig(process.env, config.rpId);
const kyc = kycConfig
  ? { config: kycConfig, sumsub: createSumsubClient({ appToken: kycConfig.appToken, secretKey: kycConfig.secretKey }) }
  : null;

// TESTNET-ONLY gas faucet: on only when its key is set. Contradicts D6; never on mainnet.
const faucetKey = process.env.TESTNET_GAS_FAUCET_KEY;
const gasSender = faucetKey
  ? ethersGasSender(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', faucetKey)
  : null;

const { app } = createApp({ config, db: openDb(config.dbPath), mailer, outbox, kyc, gasSender });

// Locally only this machine; on a host (Railway) set HOST=0.0.0.0 so its proxy can reach it.
serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? '127.0.0.1' }, ({ port }) => {
  console.log(`Login API on http://127.0.0.1:${port} (RP ID: ${config.rpId})`);
  if (config.devOutbox) console.log('Dev outbox on: email codes are shown at /dev/outbox.');
  console.log(
    !kycConfig
      ? 'KYC off: set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY (sandbox) to turn it on.'
      : `KYC on: Sumsub SANDBOX, ${kycConfig.webhookSecret ? 'webhooks' : 'polling (local development)'}.`,
  );
  console.log(
    gasSender
      ? 'TESTNET gas faucet ON (simulation, Sepolia only; contradicts D6, never on mainnet).'
      : 'Testnet gas faucet off (set TESTNET_GAS_FAUCET_KEY to enable).',
  );
});
