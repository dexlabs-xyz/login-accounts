/**
 * The Login API server: one Hono app that mounts every component.
 * Owned jointly by the passkeys and OIDC teams; changes need both to review.
 *
 *   /api/*                    passkeys (passkeys/routes.ts)
 *   /api/testnet-gas          TESTNET-ONLY gas faucet (testnet-gas/), contradicts D6
 *   /oidc/*, /.well-known/*   OIDC provider (oidc/, mounted here by the OIDC team)
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from './config.ts';
import type { DB } from './db.ts';
import { ApiError } from './http.ts';
import type { Mailer, OutboxEmail } from './mail.ts';
import { passkeyRoutes } from './passkeys/routes.ts';
import { createSessions } from './passkeys/session.ts';
import { testnetGasRoutes, type GasSender } from './testnet-gas/routes.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  mailer: Mailer;
  outbox?: OutboxEmail[];
  now?: () => number;
  /** TESTNET-ONLY gas faucet (contradicts D6; never on mainnet). Null = off. */
  gasSender?: GasSender | null;
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
  app.route('/', testnetGasRoutes({ sessions, sender: deps.gasSender ?? null, now }));

  // OIDC: mount the provider here, e.g. app.route('/', oidcRoutes({ ...deps, getSignedInUser: sessions.getSignedInUser })).

  return { app, sessions };
}
