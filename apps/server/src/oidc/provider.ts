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

/**
 * The server's own pages (consent, errors): the app's look without the app's code (Gold, 13 Nov). Inline because
 * the page allows no other styles or scripts; Geist from the app's own /fonts. Dark or light follows the device
 * (no script here to read the choice made in the app's Settings).
 */
/**
 * Lucide heart-handshake (Gold's file, 13 Nov): Login and the app, agreeing. Inline, so the page needs no images.
 * Path commands are spaced ("L 21…") so the page never contains text like "L2", which the tests rule out (no KYC level).
 */
const HANDSHAKE =
  '<svg class="handshake" width="56" height="56" viewBox="0 0 118 118" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M 14.2774 19.1939C 20.2707 13.2005 28.3994 9.8335 36.8753 9.8335C 41.6946 9.8335 46.0851 10.5227 50.3805 12.3935C 53.3938 13.706 56.2081 15.5337 59.0003 17.8936C 61.7925 15.5337 64.6068 13.706 67.6202 12.3935C 71.9155 10.5227 76.3061 9.8335 81.1253 9.8335C 89.6012 9.8335 97.7299 13.2005 103.723 19.1939C 109.717 25.1872 113.084 33.316 113.084 41.7918C 113.084 55.2725 104.188 65.1615 96.8759 72.3278L 62.4769 106.727C 60.5569 108.647 57.4438 108.647 55.5237 106.727L 21.1363 72.3394C 13.7396 65.1855 4.91699 55.3097 4.91699 41.7918C 4.91699 33.316 8.28402 25.1872 14.2774 19.1939ZM 36.8753 19.6668C 31.0074 19.6668 25.3798 21.9978 21.2306 26.1471C 17.0813 30.2963 14.7503 35.9239 14.7503 41.7918C 14.7503 50.8722 20.6538 58.1963 28.0009 65.2985L 28.0603 65.3569L 59.0003 96.2969L 89.9757 65.3215C 97.3124 58.1326 103.25 50.8186 103.25 41.7918C 103.25 35.9239 100.919 30.2963 96.7701 26.1471C 92.6208 21.9979 86.9932 19.6668 81.1253 19.6668C 77.2912 19.6668 74.3068 20.2068 71.5467 21.4089C 68.7549 22.6248 65.8842 24.6528 62.4769 28.0601C 60.5569 29.9802 57.4438 29.9802 55.5237 28.0601C 52.1164 24.6528 49.2458 22.6248 46.4539 21.4089C 43.6938 20.2068 40.7094 19.6668 36.8753 19.6668Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M 62.477 21.1066C 64.3971 23.0266 64.3971 26.1397 62.477 28.0598L 47.911 42.6258C 47.3724 43.1605 46.9449 43.7965 46.6532 44.4971C 46.3614 45.1978 46.2113 45.9492 46.2113 46.7082C 46.2113 47.4671 46.3614 48.2186 46.6532 48.9192C 46.9449 49.6199 47.3724 50.2559 47.911 50.7906L 47.9237 50.8032C 50.0774 52.957 53.5365 53.0788 55.8965 50.9797L 66.0706 41.6412C 69.5262 38.5055 74.0254 36.7686 78.6916 36.7686C 83.3535 36.7686 87.8486 38.5023 91.3029 41.6324C 91.3062 41.6354 91.3094 41.6383 91.3126 41.6412L 105.848 54.7037C 107.868 56.5187 108.034 59.6273 106.219 61.647C 104.404 63.6667 101.295 63.8327 99.2757 62.0177L 84.7047 48.9235C 83.0583 47.4295 80.9148 46.6019 78.6916 46.6019C 76.4727 46.6019 74.3331 47.4263 72.688 48.9148L 62.4794 58.285C 56.287 63.8368 46.8811 63.6605 40.9767 57.7627C 39.5204 56.3153 38.3644 54.5944 37.5752 52.6988C 36.7848 50.8005 36.3779 48.7645 36.3779 46.7082C 36.3779 44.6518 36.7848 42.6159 37.5752 40.7175C 38.3643 38.8222 39.5201 37.1015 40.9762 35.6542L 55.5238 21.1066C 57.4439 19.1865 60.5569 19.1865 62.477 21.1066Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M 75.1901 60.4401C 77.1101 58.52 80.2232 58.52 82.1433 60.4401L 91.9766 70.2734C 93.8967 72.1935 93.8967 75.3065 91.9766 77.2266C 90.0565 79.1467 86.9435 79.1467 85.0234 77.2266L 75.1901 67.3933C 73.27 65.4732 73.27 62.3601 75.1901 60.4401Z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M 60.4401 75.1901C 62.3601 73.27 65.4732 73.27 67.3933 75.1901L 77.2266 85.0234C 79.1467 86.9435 79.1467 90.0565 77.2266 91.9766C 75.3065 93.8967 72.1935 93.8967 70.2734 91.9766L 60.4401 82.1433C 58.52 80.2232 58.52 77.1101 60.4401 75.1901Z"/></svg>';

const PAGE_CSS = [
  "@font-face{font-family:Geist;src:url(/fonts/Geist-Regular.woff2) format('woff2');font-weight:400}",
  "@font-face{font-family:Geist;src:url(/fonts/Geist-Medium.woff2) format('woff2');font-weight:500}",
  ':root{--bg:#080808;--fg:#fff;--fg-rgb:255,255,255;--card:#171717;--accent:#2563eb;--muted:#a3a3a3}',
  '@media (prefers-color-scheme:light){:root{--bg:#fafafa;--fg:#0a0a0a;--fg-rgb:10,10,10;--card:#efefef;--muted:#737373}}',
  '*{box-sizing:border-box}html{background:var(--bg)}',
  // One full-window background layer, as in the app (styles.css body::before): Brave painted the plain page background
  // in bands of two slightly different shades (Gold saw it here too, 13 Nov).
  "body::before{content:'';position:fixed;inset:0;z-index:-1;background:var(--bg);will-change:transform;pointer-events:none}",
  'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;color:var(--fg);font:16px/1.4 Geist,ui-sans-serif,system-ui,sans-serif}',
  '.card{width:min(520px,100%);padding:40px 32px;border:.5px solid rgba(var(--fg-rgb),.2);border-radius:20px;display:grid;gap:20px;justify-items:center;text-align:center}',
  // Lucide heart-handshake (Gold's file), in the text colour at 60%, 56px: a little taller than the two-line title.
  '.handshake{display:block;color:var(--fg);opacity:.6;margin-bottom:8px}',
  'h1{margin:0;font-size:24px;line-height:30px;font-weight:500;max-width:380px}',
  'p{margin:0}',
  '.sees{width:100%;background:var(--card);border-radius:10px;padding:20px 22px;text-align:left;display:grid;gap:12px;font-size:14px;line-height:20px}',
  '.lead,.never{color:var(--muted)}',
  'ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}',
  "li{position:relative;padding-left:30px}",
  "li::before{position:absolute;left:2px;top:0;font-weight:500}",
  ".yes::before{content:'✓';color:var(--accent)}",
  ".no::before{content:'–';color:var(--muted)}",
  'a{color:var(--accent)}',
  'form{width:100%;margin:0}',
  'button{width:100%;height:40px;border:none;border-radius:7.88px;font:500 14px/1 Geist,sans-serif;cursor:pointer}',
  '.primary{margin-top:12px;background:var(--fg);color:var(--bg)}.primary:hover{opacity:.9}',
  '.quiet{background:none;color:var(--fg);opacity:.8}.quiet:hover{opacity:1}',
  'button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}',
  'footer{margin-top:12px;font-size:12px;color:var(--muted)}',
].join('');
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
      // font-src 'self': the app's own Geist files (no third-party fonts); still no scripts, images or frames.
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' ${redirectOrigins.join(
        ' ',
      )}; frame-ancestors 'none'; base-uri 'none'`,
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Login</title><style>${PAGE_CSS}</style><main class="card">${body}</main></html>`,
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
            ? `<p class="lead">${name} will see:</p><ul><li class="yes">An ID that only this app gets</li><li class="yes">That you’re a verified human${
                kyc.verification_sandbox === true ? ' (test mode)' : ''
              }</li></ul>`
            : `<p class="lead">${name} will see:</p><ul><li class="yes">An ID that only this app gets</li><li class="no">You haven’t verified you’re human, so it won’t see that. <a href="/#verification" target="_blank" rel="noopener">Verify on your Login account</a>, then sign in to this app again.</li></ul>`;
        // Gold, 13 Nov: the app's style, laid out like a familiar "authorize this app" screen.
        page(
          res,
          200,
          `${HANDSHAKE}<h1>${name} would like you to sign in with Login</h1><section class="sees">${sees}<p class="never">Your email, name, wallet and identity documents are never shared.</p></section><form method="post" action="/oidc/interaction/${id}/confirm"><button class="primary">Allow and continue</button></form><form method="post" action="/oidc/interaction/${id}/abort"><button class="quiet">Cancel</button></form><footer>Login · Testnet demo · Unaudited</footer>`,
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
