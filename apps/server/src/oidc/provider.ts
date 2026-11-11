/** Hackathon development implementation. Not audited or approved for production. */
import Provider, {
  interactionPolicy,
  type Configuration,
  type ClientMetadata,
} from 'oidc-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { GetSignedInUser, GetKycClaims, SignedInUser } from './contracts.ts';
import { issuerUrl, clientList } from './config.ts';
import { createStorage } from './storage.ts';

export interface OidcOptions {
  issuer: string;
  db: DatabaseSync;
  clients: ClientMetadata[];
  jwks: NonNullable<Configuration['jwks']>;
  cookieKeys: string[];
  getSignedInUser: GetSignedInUser;
  getKycClaims?: GetKycClaims;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );

export function createOidc(options: OidcOptions) {
  const issuer = issuerUrl(options.issuer);
  const clients = clientList(options.clients, issuer);
  const secure = issuer.protocol === 'https:';
  const redirectOrigins = [
    ...new Set(
      clients.flatMap((client) => client.redirect_uris ?? []).map((uri) => new URL(uri).origin),
    ),
  ];
  const store = createStorage(options.db);
  const freshRequests = store.adapter('FreshAuthentication');
  const getUser = async (req: IncomingMessage): Promise<SignedInUser | null> => {
    const user = await options.getSignedInUser(req);
    if (
      !user ||
      user.method !== 'passkey' ||
      user.userVerified !== true ||
      !user.userId ||
      !Number.isSafeInteger(user.authenticatedAt) ||
      user.authenticatedAt > Date.now() / 1000 + 1
    )
      return null;
    return user;
  };
  const policy = interactionPolicy.base();
  policy.get('login')!.checks.add(
    new interactionPolicy.Check(
      'shared_session',
      'A current Login session is required',
      'login_required',
      async (ctx) => {
        const user = await getUser(ctx.req);
        return (
          !user || (!!ctx.oidc.session?.accountId && ctx.oidc.session?.accountId !== user.userId)
        );
      },
    ),
  );
  const provider = new Provider(options.issuer, {
    adapter: store.adapter,
    clients: clients.map((client) => ({
      ...client,
      subject_type: 'pairwise',
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    })),
    jwks: options.jwks,
    cookies: {
      keys: options.cookieKeys,
      short: { sameSite: 'lax', httpOnly: true, secure },
      long: { sameSite: 'lax', httpOnly: true, secure },
    },
    features: { devInteractions: { enabled: false } },
    scopes: ['openid'],
    claims: { openid: ['sub', 'verified_human', 'verification_sandbox'] },
    subjectTypes: ['pairwise'],
    pairwiseIdentifier: (_ctx, accountId, client) => store.subject(accountId, client.clientId),
    pkce: { required: () => true },
    clientAuthMethods: ['none'],
    responseTypes: ['code'],
    ttl: {
      AuthorizationCode: 60,
      AccessToken: 300,
      IdToken: 300,
      Interaction: 600,
      Session: 3600,
      Grant: 3600,
    },
    interactions: {
      policy,
      url: (_ctx, interaction) => `/oidc/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx, accountId) => ({
      accountId,
      async claims(_use, scope) {
        const claims = (await options.getKycClaims?.(accountId, scope.split(' '))) ?? {};
        // Match KYC: absence means not checked/unverified, never a negative assertion.
        // This iteration supports openid only, so even an adapter returning a level
        // cannot disclose it until a dedicated scope and consent flow are implemented.
        return {
          sub: accountId,
          ...(claims.verified_human === true
            ? {
                verified_human: true,
                ...(claims.verification_sandbox === true ? { verification_sandbox: true } : {}),
              }
            : {}),
        };
      },
    }),
    renderError: async (ctx) => {
      ctx.type = 'html';
      ctx.body = '<h1>Unable to continue signing in</h1><p>Return to the app and try again.</p>';
    },
  });
  // The external origin comes only from the validated issuer, never forwarded input.
  provider.proxy = true;
  const callback = provider.callback();
  const redirect = (res: ServerResponse, path: string) => {
    res.writeHead(303, { location: path });
    res.end();
  };
  const page = (res: ServerResponse, status: number, body: string) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${redirectOrigins.join(
        ' ',
      )}; frame-ancestors 'none'; base-uri 'none'`,
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Login</title><style>body{font:18px system-ui;max-width:560px;margin:12vh auto;padding:24px;background:#faf9f6;color:#20251f}button{padding:12px 20px;margin:8px;font:inherit;cursor:pointer}small{color:#555}</style>${body}</html>`,
    );
  };
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Vite's proxy can replace Host with the API's internal address. Endpoint URLs
    // must use the configured public issuer, never that address or a forwarded header.
    req.headers.host = issuer.host;
    req.headers['x-forwarded-host'] = issuer.host;
    req.headers['x-forwarded-proto'] = issuer.protocol.slice(0, -1);
    delete req.headers.forwarded;
    const url = new URL(req.url ?? '/', issuer.origin);
    const match = /^\/oidc\/interaction\/([A-Za-z0-9_-]+)(?:\/(complete|abort|confirm))?$/.exec(
      url.pathname,
    );
    if (match) {
      res.setHeader('cache-control', 'no-store');
      try {
        const interaction = await provider.interactionDetails(req, res);
        const id = match[1]!;
        if (interaction.uid !== id) throw new Error('Invalid interaction');
        const action = match[2];
        if (action === 'abort') {
          if (req.method !== 'POST' && req.method !== 'GET') {
            page(res, 405, '<h1>Method not allowed</h1>');
            return true;
          }
          // Cancellation must also originate within Login; the interaction cookie binds it to this browser.
          if (req.method === 'POST' && req.headers.origin !== issuer.origin) {
            page(res, 403, '<h1>Request rejected</h1>');
            return true;
          }
          await provider.interactionFinished(
            req,
            res,
            {
              error: 'access_denied',
              error_description: 'Sign-in was cancelled or could not be completed.',
            },
            { mergeWithLastSubmission: false },
          );
          return true;
        }
        const user = await getUser(req);
        if (interaction.prompt.name === 'login') {
          const prompts = String(interaction.params.prompt ?? '').split(' ');
          const maxAge =
            interaction.params.max_age === undefined
              ? undefined
              : Number(interaction.params.max_age);
          const fresh =
            prompts.includes('login') ||
            (maxAge !== undefined &&
              (!user || Math.floor(Date.now() / 1000) - user.authenticatedAt > maxAge));
          if (fresh && action !== 'complete') {
            const existing = await freshRequests.find(id);
            if (!existing)
              await freshRequests.upsert(
                id,
                {
                  extra: {
                    previousAuthentication: user
                      ? user.authenticatedAtMs ?? user.authenticatedAt * 1000
                      : 0,
                  },
                },
                600,
              );
          }
          const freshRequest = await freshRequests.find(id);
          const previous = freshRequest?.extra?.previousAuthentication;
          const authenticationAdvanced =
            typeof previous !== 'number' ||
            (user && (user.authenticatedAtMs ?? user.authenticatedAt * 1000) > previous);
          // Preserve the passkey component's precision: a reused recent session
          // cannot satisfy a demanded new check, even within the same second.
          const freshEnough =
            user &&
            (!prompts.includes('login') || user.authenticatedAt >= interaction.iat) &&
            (maxAge === undefined ||
              Math.floor(Date.now() / 1000) - user.authenticatedAt <= maxAge);
          if (
            !user ||
            !freshEnough ||
            !authenticationAdvanced ||
            (prompts.includes('login') && action !== 'complete')
          ) {
            if (action === 'complete') {
              page(
                res,
                401,
                '<h1>Passkey check required</h1><p>The sign-in did not establish a sufficiently recent session. Return to the app and retry.</p>',
              );
              return true;
            }
            redirect(
              res,
              `/signin?interaction=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`,
            );
            return true;
          }
          if (freshRequest) await freshRequests.destroy(id);
          await provider.interactionFinished(
            req,
            res,
            {
              login: {
                accountId: user.userId,
                ts: user.authenticatedAt,
                amr: ['passkey'],
                remember: true,
              },
            },
            { mergeWithLastSubmission: false },
          );
          return true;
        }
        const accountId = interaction.session?.accountId;
        if (!user || user.userId !== accountId) {
          page(res, 401, '<h1>Session changed</h1><p>Return to the app and sign in again.</p>');
          return true;
        }
        if (interaction.prompt.name !== 'consent') throw new Error('Unsupported interaction');
        if (req.method === 'POST' && action === 'confirm') {
          if (req.headers.origin !== issuer.origin) {
            page(res, 403, '<h1>Request rejected</h1>');
            return true;
          }
          const grant = interaction.grantId
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({
                accountId,
                clientId: String(interaction.params.client_id),
              });
          if (!grant) throw new Error('Grant missing');
          grant.addOIDCScope('openid');
          grant.addOIDCClaims(['verified_human', 'verification_sandbox']);
          const grantId = await grant.save();
          await provider.interactionFinished(
            req,
            res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true },
          );
          return true;
        }
        if (req.method !== 'GET' || action) {
          page(res, 405, '<h1>Method not allowed</h1>');
          return true;
        }
        const client = await provider.Client.find(String(interaction.params.client_id));
        const name = escape(client?.clientName ?? 'this app');
        // Show the user their own status, so they know exactly what this app will learn.
        const kyc = (await options.getKycClaims?.(accountId, ['openid'])) ?? {};
        const sees =
          kyc.verified_human === true
            ? `<p><strong>${name} will see:</strong> an ID that only this app gets, and that you’re a <strong>verified human${
                kyc.verification_sandbox === true ? ' (test mode)' : ''
              }</strong>.</p>`
            : `<p><strong>${name} will see:</strong> an ID that only this app gets. You haven’t verified you’re human, so it won’t see that. <a href="/" target="_blank" rel="noopener">Verify on your Login account</a>, then sign in to this app again.</p>`;
        page(
          res,
          200,
          `<small>Login · Testnet demo · Unaudited</small><h1>Continue to ${name}?</h1>${sees}<p>Your email, name, wallet and identity documents are never shared.</p><form method="post" action="/oidc/interaction/${id}/confirm"><button>Allow and continue</button></form><form method="post" action="/oidc/interaction/${id}/abort"><button>Cancel</button></form>`,
        );
        return true;
      } catch {
        if (!res.headersSent)
          page(
            res,
            400,
            '<h1>Sign-in expired or invalid</h1><p>Return to the app and start again.</p>',
          );
        return true;
      }
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      redirect(res, '/oidc/.well-known/openid-configuration');
      return true;
    }
    if (url.pathname === '/oidc' || url.pathname.startsWith('/oidc/')) {
      (req as IncomingMessage & { originalUrl: string }).originalUrl = req.url ?? '/';
      req.url = (req.url ?? '/').slice('/oidc'.length) || '/';
      callback(req, res);
      return true;
    }
    return false;
  }
  return { provider, handle };
}
