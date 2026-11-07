/** OIDC mounted within the shared Hono server; uses passkeys' public session contract. */
import { Hono, type Handler } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { DB } from '../db.ts';
import type { Sessions } from '../passkeys/session.ts';
import type { GetKycClaims } from './contracts.ts';
import { loadOidcConfig } from './config.ts';
import { createOidc } from './provider.ts';

export function oidcRoutes(options: {
  db: DB;
  sessions: Sessions;
  issuer: string;
  getKycClaims?: GetKycClaims;
}) {
  const configuration = loadOidcConfig(process.env, options.issuer);
  const oidc = createOidc({
    ...configuration,
    db: options.db,
    getKycClaims: options.getKycClaims,
    async getSignedInUser(request) {
      const user = options.sessions.getSignedInUser(request.headers.cookie);
      // Passkeys owns millisecond timestamps; OIDC Core uses Unix seconds.
      return user
        ? {
            ...user,
            authenticatedAt: Math.floor(user.authenticatedAt / 1000),
            authenticatedAtMs: user.authenticatedAt,
          }
        : null;
    },
  });
  const routes = new Hono<{ Bindings: HttpBindings }>();
  const handler: Handler<{ Bindings: HttpBindings }> = async (c) => {
    if (!c.env?.incoming || !c.env?.outgoing) return c.json({ error: 'node-server-required' }, 503);
    const { incoming, outgoing } = c.env;
    // oidc-provider writes its own Node response. Wait until it finishes, then tell Hono
    // that it must not write another response or consume the request body.
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        outgoing.off('finish', finish);
        outgoing.off('close', finish);
        outgoing.off('error', fail);
      };
      outgoing.once('finish', finish);
      outgoing.once('close', finish);
      outgoing.once('error', fail);
      void oidc.handle(incoming, outgoing).catch(fail);
    });
    return RESPONSE_ALREADY_SENT;
  };
  routes.all('/oidc', handler);
  routes.all('/oidc/*', handler);
  routes.all('/.well-known/openid-configuration', handler);
  return routes;
}
