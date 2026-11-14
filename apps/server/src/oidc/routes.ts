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
  /**
   * The apps this account has signed in to with Login, and what they can see.
   * From oidc_subjects (one row per account and app, made when the app first gets
   * its per-app ID). Exact level sharing is recorded per app by its active grant.
   */
  routes.get('/api/oidc/apps', async (c) => {
    const user = options.sessions.getSignedInUser(c.req.header('cookie'));
    if (!user) return c.json({ error: 'not-signed-in' }, 401);
    const names = new Map(configuration.clients.map((cl) => [cl.client_id, cl.client_name]));
    const rows = options.db
      .prepare('SELECT client_id FROM oidc_subjects WHERE account_id = ? ORDER BY rowid')
      .all(user.userId) as { client_id: string }[];
    const kyc = (await options.getKycClaims?.(user.userId, ['openid'])) ?? {};
    return c.json({
      apps: await Promise.all(
        rows.map(async (r) => {
          const grants = options.db
            .prepare(
              `SELECT id FROM oidc_records
          WHERE model='Grant' AND json_extract(payload, '$.accountId')=?
          AND json_extract(payload, '$.clientId')=? AND (expires_at IS NULL OR expires_at>?)`,
            )
            .all(user.userId, r.client_id, Math.floor(Date.now() / 1000)) as {
            id: string;
          }[];
          let sharesVerificationLevel = false;
          for (const row of grants) {
            const grant = await oidc.provider.Grant.find(row.id);
            if (grant?.getOIDCScope().split(' ').includes('kyc_level'))
              sharesVerificationLevel = true;
          }
          return {
            name: names.get(r.client_id) ?? 'An app no longer listed',
            ...(sharesVerificationLevel ? { sharesVerificationLevel: true } : {}),
          };
        }),
      ),
      verifiedHuman: kyc.verified_human === true,
      sandbox: kyc.verification_sandbox === true,
    });
  });
  routes.all('/oidc', handler);
  routes.all('/oidc/*', handler);
  routes.all('/.well-known/openid-configuration', handler);
  return routes;
}
