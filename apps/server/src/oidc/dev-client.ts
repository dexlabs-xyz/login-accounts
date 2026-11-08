/** Testnet demo relying party. Separate optional process; not production-ready or audited. */
import { createServer } from 'node:http';
import * as client from 'openid-client';
import { demoClientConfig } from './config.ts';
const { issuer, origin, secure, clientId: configuredClientId } = demoClientConfig();
const secureCookie = secure ? '; Secure' : '';
const pending = new Map<
  string,
  { verifier: string; nonce: string; clientId: string; expires: number }
>();
const results = new Map<
  string,
  {
    subject: string;
    verified: boolean;
    sandbox: boolean;
    clientId: string;
    expires: number;
  }
>();
async function configuration(id: string) {
  // Discover afresh: the local provider generates new signing keys when restarted.
  return client.discovery(issuer, id, undefined, client.None(), {
    execute: [...(secure ? [] : [client.allowInsecureRequests]), client.enableNonRepudiationChecks],
  });
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
const cookie = (req: import('node:http').IncomingMessage, name: string) =>
  new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  const page = (body: string, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Login demo app</title><style>body{font:18px system-ui;max-width:600px;margin:12vh auto;padding:24px;background:#faf9f6;color:#20251f}a{display:inline-block;padding:12px;color:#145c3f}small{color:#555}code{overflow-wrap:anywhere}</style><small>Testnet demo · Test accounts only · Unaudited</small>${body}</html>`,
    );
  };
  const redirect = (path: string) => {
    res.writeHead(303, { location: path });
    res.end();
  };
  try {
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
    for (const [id, value] of results) if (value.expires < Date.now()) results.delete(id);
    if (url.pathname === '/start') {
      if (pending.size >= 500) {
        page('<h1>Try again shortly</h1>', 429);
        return;
      }
      const clientId =
        !secure && url.searchParams.get('app') === 'second' ? 'second-local' : configuredClientId;
      const config = await configuration(clientId);
      const state = client.randomState(),
        nonce = client.randomNonce(),
        verifier = client.randomPKCECodeVerifier();
      pending.set(state, {
        verifier,
        nonce,
        clientId,
        expires: Date.now() + 600_000,
      });
      const target = client.buildAuthorizationUrl(config, {
        redirect_uri: `${origin}/callback`,
        scope: 'openid',
        state,
        nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        ...(url.searchParams.has('fresh') ? { prompt: 'login' } : {}),
      });
      res.setHeader(
        'set-cookie',
        `oidc_flow_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secureCookie}`,
      );
      redirect(target.href);
      return;
    }
    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') ?? '',
        stored = pending.get(state);
      pending.delete(state);
      if (!stored || cookie(req, 'oidc_flow_state') !== state) {
        page('<h1>Request expired or invalid</h1><a href="/">Start again</a>', 400);
        return;
      }
      const config = await configuration(stored.clientId);
      // The library validates issuer, audience, nonce, state, expiry, PKCE and ID-token signature.
      const tokens = await client.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: stored.verifier,
        expectedState: state,
        expectedNonce: stored.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims) throw new Error('No ID token');
      const info = await client.fetchUserInfo(config, tokens.access_token, claims.sub);
      const resultId = client.randomState();
      results.set(resultId, {
        subject: claims.sub,
        verified: info.verified_human === true,
        sandbox: info.verification_sandbox === true,
        clientId: stored.clientId,
        expires: Date.now() + 600_000,
      });
      res.setHeader('set-cookie', [
        `oidc_flow_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`,
        `oidc_demo_result=${resultId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secureCookie}`,
      ]);
      redirect('/result');
      return;
    }
    if (url.pathname === '/result') {
      const result = results.get(cookie(req, 'oidc_demo_result') ?? '');
      if (!result) {
        redirect('/');
        return;
      }
      page(
        `<h1>Signed in to ${
          result.clientId === 'chess-local' ? 'the chess demo' : 'the second demo app'
        }</h1><p>The OIDC client validated the sign-in response and ID-token signature.</p><p>Your ID for this app:<br><code>${escape(
          result.subject,
        )}</code></p><p>Verified human: <strong>${
          result.verified ? 'Yes' : 'Not provided'
        }</strong>${
          result.sandbox ? ' (sandbox verification)' : ''
        }</p><p>No email, name or wallet information was shared.</p><a href="/">Try another flow</a>`,
      );
      return;
    }
    page(
      `<h1>Try Continue with Login</h1><p>Test passkey sign-in, consent, cancellation, token validation and per-app IDs. Use test accounts only; no real KYC documents or funds.</p><a href="/start">Continue with Login</a>${
        secure ? '' : '<a href="/start?app=second">Try a second app</a>'
      }<a href="/start?fresh=1">Require a fresh sign-in</a>`,
    );
  } catch (error) {
    // Error codes only: never log tokens, claims, requests or error descriptions.
    const failure = error as { code?: string; cause?: { code?: string } };
    console.error('Demo validation failed:', failure.code ?? 'unknown', failure.cause?.code ?? '');
    page(
      '<h1>Sign-in did not complete</h1><p>The request was cancelled, expired, or could not be validated.</p><a href="/">Try again</a>',
      400,
    );
  }
}).listen(Number(process.env.PORT ?? 5190), secure ? '0.0.0.0' : '127.0.0.1', () =>
  console.log('Unaudited demo client listening.'),
);
