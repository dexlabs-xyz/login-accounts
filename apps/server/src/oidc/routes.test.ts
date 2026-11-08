import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { serve } from '@hono/node-server';
import { createApp } from '../app.ts';
import { openDb } from '../db.ts';
import { loadConfig } from '../config.ts';
import type { Server } from 'node:http';
import type { DB } from '../db.ts';
import type { GetKycClaims } from './contracts.ts';
import { DEMO_ISSUER, generateOidcKeys } from './config.ts';
afterEach(() => vi.unstubAllEnvs());

/**
 * Signs `test-user` in to the local demo app through the real shared server
 * (passkey session -> OIDC consent -> token) and returns what /oidc/me says.
 * `setup` runs on the database first (e.g. to record a KYC result).
 */
async function signInToDemoApp(
  opts: {
    getKycClaims?: GetKycClaims;
    setup?: (db: DB) => void;
    hosted?: boolean;
    hostedRpId?: string;
  } = {},
) {
  const issuer = opts.hosted ? DEMO_ISSUER : 'http://localhost:5180/oidc';
  const publicOrigin = new URL(issuer).origin;
  const callback = opts.hosted
    ? 'https://chess-demo.withlogin.com/api/login/callback'
    : 'http://localhost:5190/callback';
  if (opts.hosted) {
    const keys = generateOidcKeys();
    vi.stubEnv('OIDC_JWKS', JSON.stringify(keys.jwks));
    vi.stubEnv('OIDC_COOKIE_KEYS', JSON.stringify(keys.cookieKeys));
    vi.stubEnv(
      'OIDC_CLIENTS',
      JSON.stringify([
        {
          client_id: 'chess-local',
          client_name: 'Hosted Chess',
          redirect_uris: [callback],
        },
      ]),
    );
  }
  const db = openDb(':memory:');
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(
    'test-user',
    'test@example.com',
    'test-handle',
    Date.now(),
  );
  opts.setup?.(db);
  const { app, sessions } = createApp({
    ...(opts.getKycClaims ? { getKycClaims: opts.getKycClaims } : {}),
    config: loadConfig(
      opts.hosted
        ? {
            WEBAUTHN_RP_ID: opts.hostedRpId ?? 'demo.withlogin.com',
            WEBAUTHN_ORIGINS: publicOrigin,
          }
        : {},
    ),
    db,
    mailer: { async send() {} },
    oidcIssuer: issuer,
  });
  // Test-only route uses the passkey component's public session API.
  app.post('/test/session', (c) => {
    sessions.start(c, 'test-user');
    return c.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () =>
      resolve(s as Server),
    );
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<string, string>();
  const request = async (path: string, method = 'GET', init: RequestInit = {}) => {
    const response = await fetch(origin + path, {
      ...init,
      method,
      redirect: 'manual',
      headers: {
        host: 'internal.railway.invalid',
        'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'http',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...init.headers,
      },
    });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0]!,
        at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  try {
    const discovery = await (await request('/oidc/.well-known/openid-configuration')).json();
    expect(discovery.issuer).toBe(issuer);
    expect(discovery.authorization_endpoint).toBe(issuer + '/auth');
    expect((await request('/api/me')).status).toBe(401);
    await request('/test/session', 'POST');
    expect((await request('/api/me')).status).toBe(200);
    const auth = await request(
      '/oidc/auth?' +
        new URLSearchParams({
          client_id: 'chess-local',
          redirect_uri: callback,
          response_type: 'code',
          scope: 'openid',
          code_challenge: createHash('sha256').update('a'.repeat(64)).digest('base64url'),
          code_challenge_method: 'S256',
        }),
    );
    expect(auth.status).toBe(303);
    if (opts.hosted) {
      expect(auth.headers.getSetCookie().length).toBeGreaterThan(0);
      expect(auth.headers.getSetCookie().every((cookie) => /; secure/i.test(cookie))).toBe(true);
      const target = new URL(auth.headers.get('location')!, publicOrigin);
      expect(target.origin).toBe(publicOrigin);
      expect((await request('/.well-known/openid-configuration')).headers.get('location')).toBe(
        '/oidc/.well-known/openid-configuration',
      );
    }
    const interaction = await request(
      new URL(auth.headers.get('location')!, 'http://localhost:5180').pathname,
    );
    expect(interaction.status).toBe(303);
    // A valid shared passkey session must be accepted, not sent back to /signin.
    expect(interaction.headers.get('location')?.includes('/signin')).toBe(false);
    expect(interaction.headers.get('location')?.includes('/oidc/auth/')).toBe(true);
    const pathOf = (location: string) => {
      const url = new URL(location, 'http://localhost:5180');
      return url.pathname + url.search;
    };
    const resumed = await request(pathOf(interaction.headers.get('location')!));
    const consentPath = pathOf(resumed.headers.get('location')!);
    expect((await request(consentPath)).status).toBe(200);
    if (opts.hosted) {
      const rejected = await request(consentPath + '/confirm', 'POST', {
        headers: { origin: 'https://attacker.invalid' },
      });
      expect(rejected.status).toBe(403);
    }
    const confirmed = await request(consentPath + '/confirm', 'POST', {
      headers: { origin: publicOrigin },
    });
    const complete = await request(pathOf(confirmed.headers.get('location')!));
    const code = new URL(complete.headers.get('location')!).searchParams.get('code')!;
    const tokenResponse = await request('/oidc/token', 'POST', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'chess-local',
        redirect_uri: callback,
        code,
        code_verifier: 'a'.repeat(64),
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json();
    const info = await (
      await request('/oidc/me', 'GET', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })
    ).json();
    return info as Record<string, unknown>;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

it('mounts OIDC in the shared Hono app, uses canonical public URLs and reads the passkey session in milliseconds', async () => {
  const getKycClaims = vi.fn(async () => ({
    verified_human: true as const,
    kyc_level: 'L2' as const,
    verification_sandbox: true as const,
  }));
  const info = await signInToDemoApp({ getKycClaims });
  expect(getKycClaims).toHaveBeenCalledWith('test-user', ['openid']);
  expect(info.verified_human).toBe(true);
  expect(info.verification_sandbox).toBe(true);
  expect(Object.hasOwn(info, 'kyc_level')).toBe(false);
});

// The real hand-off between the two components, as wired in app.ts (no stand-ins).
it('a user who passed KYC L1 reaches apps as verified_human (sandbox); the level stays private', async () => {
  const info = await signInToDemoApp({
    setup: (db) =>
      db
        .prepare('INSERT INTO kyc_status (user_id, level, updated_at) VALUES (?, ?, ?)')
        .run('test-user', 'L1', Date.now()),
  });
  expect(info.verified_human).toBe(true);
  expect(info.verification_sandbox).toBe(true);
  expect(Object.hasOwn(info, 'kyc_level')).toBe(false);
});

it('a user who has not passed KYC gets no verified_human claim at all (never false)', async () => {
  const info = await signInToDemoApp();
  expect(Object.hasOwn(info, 'verified_human')).toBe(false);
  expect(Object.hasOwn(info, 'verification_sandbox')).toBe(false);
});

it('serves HTTPS discovery, Secure cookies and KYC with the live demo.withlogin.com RP behind a proxy', async () => {
  const info = await signInToDemoApp({
    hosted: true,
    setup: (db) =>
      db
        .prepare('INSERT INTO kyc_status (user_id, level, updated_at) VALUES (?, ?, ?)')
        .run('test-user', 'L1', Date.now()),
  });
  expect(info.verified_human).toBe(true);
  expect(info.verification_sandbox).toBe(true);
  expect(Object.hasOwn(info, 'kyc_level')).toBe(false);
});

it('also accepts the parent withlogin.com RP without changing the configured passkey domain', async () => {
  const info = await signInToDemoApp({ hosted: true, hostedRpId: 'withlogin.com' });
  expect(typeof info.sub).toBe('string');
});

it.each([
  { rpId: 'localhost' },
  { rpId: 'other.withlogin.com' },
  { rpId: 'login.com' },
  { rpId: 'withlogin.com.attacker.invalid' },
  { secureCookies: false },
  { origins: ['https://other.withlogin.com'] },
])('rejects an incompatible hosted passkey configuration: %j', (override) => {
  const db = openDb(':memory:');
  try {
    const config = {
      ...loadConfig({
        WEBAUTHN_RP_ID: 'demo.withlogin.com',
        WEBAUTHN_ORIGINS: 'https://demo.withlogin.com',
      }),
      ...override,
    };
    expect(() =>
      createApp({ config, db, mailer: { async send() {} }, oidcIssuer: DEMO_ISSUER }),
    ).toThrow('OIDC issuer and passkey origin/RP configuration must agree.');
  } finally {
    db.close();
  }
});
