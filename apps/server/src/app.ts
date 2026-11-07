/**
 * The Login API server: one Hono app that mounts every component.
 * Owned jointly by the passkeys and OIDC teams; changes need both to review.
 *
 *   /api/*                    passkeys (passkeys/routes.ts)
 *   /api/kyc/*                KYC (kyc/routes.ts)
 *   /api/testnet-gas          TESTNET-ONLY gas faucet (testnet-gas/), contradicts D6
 *   /oidc/*, /.well-known/*   OIDC provider (oidc/, mounted here by the OIDC team)
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { ApiError } from './http.ts';
import type { Mailer, OutboxEmail } from './mail.ts';
import { createGetKycClaims } from './kyc/claims.ts';
import { kycRoutes, type KycDeps } from './kyc/routes.ts';
import { passkeyRoutes } from './passkeys/routes.ts';
import type { GetKycClaims } from './oidc/contracts.ts';
import { oidcRoutes } from './oidc/routes.ts';
import { createSessions } from './passkeys/session.ts';
import { testnetGasRoutes, type GasSender } from './testnet-gas/routes.ts';
import { testFundsRoutes } from './test-funds/routes.ts';
import type { TestFundsSender } from './test-funds/sender.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  mailer: Mailer;
  outbox?: OutboxEmail[];
  /** Sumsub sandbox KYC (kyc/). null or missing: KYC is off, everything else works. */
  kyc?: KycDeps | null;
  now?: () => number;
  /** TESTNET-ONLY gas faucet (contradicts D6; never on mainnet). Null = off. */
  gasSender?: GasSender | null;
  /** TESTNET-ONLY test-funds pool (exception to D6; never on mainnet). Null = off. */
  testFunds?: TestFundsSender | null;
  /** Explicit opt-in for the localhost-only OIDC iteration. */
  oidcIssuer?: string;
  /** Adapter supplied by the KYC component when PR #4 and OIDC are combined. */
  getKycClaims?: GetKycClaims;
}

export function createApp(deps: AppDeps) {
  const now = deps.now ?? Date.now;
  const sessions = createSessions(deps.db, deps.config, now);

  const app = new Hono();
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, ...err.extra }, err.status);
    // Don't echo internal errors; they could contain request data.
    console.error('Unhandled error:', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'server-error' }, 500);
  });

  app.route('/', passkeyRoutes({ ...deps, sessions, now }));
  app.route(
    '/',
    kycRoutes({ db: deps.db, kyc: deps.kyc ?? null, session: sessions.require, now, localDev: deps.config.rpId === 'localhost' }),
  );
  app.route('/', testnetGasRoutes({ sessions, sender: deps.gasSender ?? null, now }));
  app.route('/', testFundsRoutes({ db: deps.db, sessions, sender: deps.testFunds ?? null, now }));

  const oidcIssuer = deps.oidcIssuer ?? (process.env.OIDC_ENABLED === '1'
    ? process.env.OIDC_ISSUER ?? 'http://localhost:5180/oidc' : undefined);
  if (oidcIssuer) {
    if (deps.config.rpId !== 'localhost') throw new Error('Local OIDC requires the localhost passkey configuration.');
    // KYC owns the level lookup; OIDC only passes the scopes the user granted (agreed on PR #4).
    const getKycClaims = deps.getKycClaims ?? createGetKycClaims(deps.db);
    app.route('/', oidcRoutes({ db: deps.db, sessions, issuer: oidcIssuer, getKycClaims }));
  }

  return { app, sessions };
}
