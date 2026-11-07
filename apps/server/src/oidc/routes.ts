/** OIDC mounted within the shared Hono server; uses passkeys' public session contract. */
import { Hono, type Handler } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { DB } from '../db.ts';
import type { Sessions } from '../passkeys/session.ts';
import type { GetKycClaims } from './contracts.ts';
import { createOidc } from './provider.ts';

export function oidcRoutes(options: {
  db: DB;
  sessions: Sessions;
  issuer: string;
  getKycClaims?: GetKycClaims;
}) {
  // Development only; never written to disk or logged. Production key management is out of scope.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const oidc = createOidc({
    db: options.db,
    issuer: options.issuer,
    getKycClaims: options.getKycClaims,
    jwks: {
      keys: [
        { ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' },
      ],
    },
    cookieKeys: [randomUUID(), randomUUID()],
    clients: [
      {
        client_id: 'chess-app-local',
        client_name: 'Login Chess',
        redirect_uris: ['http://localhost:5190/api/login/callback'],
      },
      {
        client_id: 'chess-local',
        client_name: 'Chess demo',
        redirect_uris: ['http://localhost:5190/callback'],
      },
      {
        client_id: 'second-local',
        client_name: 'Second demo app',
        redirect_uris: ['http://localhost:5190/callback'],
      },
    ],
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
