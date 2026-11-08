import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setDefaultResultOrder } from 'node:dns';
import { createOidc, type OidcOptions } from './provider.ts';
import { createStorage } from './storage.ts';
import { migrate } from '../migrations/index.ts';
import type { SignedInUser, KycClaims } from './contracts.ts';
setDefaultResultOrder('ipv4first');
const servers: Server[] = [];
const databases: DatabaseSync[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  databases.splice(0).forEach((db) => db.close());
});
async function fixture() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  databases.push(db);
  let oidc: ReturnType<typeof createOidc>;
  let user: SignedInUser | null = null;
  let verification: KycClaims = {};
  const server = createServer((req, res) => {
    void oidc.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://localhost:${port}`;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const options: OidcOptions = {
    issuer: `${origin}/oidc`,
    db,
    cookieKeys: [randomUUID()],
    jwks: {
      keys: [
        {
          ...privateKey.export({ format: 'jwk' }),
          kid: 'test',
          use: 'sig',
          alg: 'RS256',
        },
      ],
    },
    clients: ['app-a', 'app-b'].map((id) => ({
      client_id: id,
      client_name: id,
      redirect_uris: ['http://localhost:5190/callback'],
    })),
    getSignedInUser: async () => user,
    getKycClaims: async (_id, scopes) => {
      expect(scopes).toEqual(['openid']);
      return verification;
    },
  };
  oidc = createOidc(options);
  const cookies = new Map<string, string>();
  async function request(path: string, init: RequestInit = {}, jar = cookies) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: 'manual',
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...init.headers,
      },
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair!.indexOf('=');
      jar.set(pair!.slice(0, at), pair!.slice(at + 1));
    }
    return response;
  }
  const verifier = 'a'.repeat(64);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = (id = 'app-a', extra: Record<string, string> = {}) =>
    '/oidc/auth?' +
    new URLSearchParams({
      client_id: id,
      redirect_uri: 'http://localhost:5190/callback',
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'test-state',
      nonce: 'test-nonce',
      ...extra,
    });
  async function finish(path: string): Promise<URL> {
    for (let i = 0; i < 12; i++) {
      const response = await request(path);
      const location = response.headers.get('location');
      if (location?.startsWith('http://localhost:5190/')) return new URL(location);
      if (location?.startsWith('/signin')) {
        user = {
          userId: 'internal-user',
          authenticatedAt: Math.floor(Date.now() / 1000),
          method: 'passkey',
          userVerified: true,
        };
        path = `/oidc/interaction/${new URL(location, origin).searchParams.get(
          'interaction',
        )}/complete`;
      } else if (location) path = location;
      else {
        const html = await response.text();
        const action = /action="([^"]+\/confirm)"/.exec(html)?.[1];
        if (!action) throw new Error(`Unexpected flow response (${response.status})`);
        const approved = await request(action, {
          method: 'POST',
          headers: { origin },
        });
        path = approved.headers.get('location')!;
      }
    }
    throw new Error('Too many redirects');
  }
  async function exchange(code: string, id = 'app-a', codeVerifier = verifier) {
    return request('/oidc/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: id,
        redirect_uri: 'http://localhost:5190/callback',
        code,
        code_verifier: codeVerifier,
      }),
    });
  }
  return {
    db,
    oidc,
    origin,
    request,
    authorize,
    finish,
    exchange,
    restart() {
      oidc = createOidc(options);
    },
    setUser(value: SignedInUser | null) {
      user = value;
    },
    setVerification(value: KycClaims) {
      verification = value;
    },
  };
}
describe('OIDC local integration', () => {
  it('serves discovery with the mounted issuer and requires PKCE', async () => {
    const f = await fixture();
    const discovery = await (await f.request('/oidc/.well-known/openid-configuration')).json();
    expect(discovery.issuer).toBe(`${f.origin}/oidc`);
    expect(discovery.authorization_endpoint).toBe(`${f.origin}/oidc/auth`);
    const result = await f.request(
      f
        .authorize()
        .replace(/&code_challenge=[^&]+/, '')
        .replace('&code_challenge_method=S256', ''),
    );
    expect(result.headers.get('location')?.includes('error=invalid_request')).toBe(true);
  });
  it('completes consent and code exchange, keeps per-app IDs stable and distinct, and rejects code reuse', async () => {
    const f = await fixture();
    const subjects: string[] = [];
    for (const id of ['app-a', 'app-b', 'app-a']) {
      const callback = await f.finish(f.authorize(id));
      expect(callback.searchParams.get('state')).toBe('test-state');
      const code = callback.searchParams.get('code')!;
      const response = await f.exchange(code, id);
      expect(response.status).toBe(200);
      const tokens = await response.json();
      const info = await (
        await f.request('/oidc/me', {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).json();
      expect(typeof info.sub === 'string' && info.sub !== 'internal-user').toBe(true);
      expect(Object.hasOwn(info, 'verified_human')).toBe(false);
      expect(info.email).toBeUndefined();
      subjects.push(info.sub);
      expect((await f.exchange(code, id)).status).toBe(400);
    }
    expect(subjects[0] === subjects[2]).toBe(true);
    expect(subjects[0] !== subjects[1]).toBe(true);
  });
  it('rejects a wrong PKCE verifier and unregistered redirect', async () => {
    const f = await fixture();
    const callback = await f.finish(f.authorize());
    expect(
      (await f.exchange(callback.searchParams.get('code')!, 'app-a', 'b'.repeat(64))).status,
    ).toBe(400);
    const response = await f.request(
      f.authorize('app-a', { redirect_uri: 'http://evil.invalid/callback' }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });
  it('does not complete interactions in another browser or with a different interaction ID', async () => {
    const f = await fixture();
    const start = await f.request(f.authorize());
    const location = start.headers.get('location')!;
    expect((await f.request(location, {}, new Map())).status).toBe(400);
    expect((await f.request('/oidc/interaction/not-the-right-id/complete')).status).toBe(400);
  });
  it('rejects cross-origin consent and supports cancellation', async () => {
    const f = await fixture();
    f.setUser({
      userId: 'internal-user',
      authenticatedAt: Math.floor(Date.now() / 1000),
      method: 'passkey',
      userVerified: true,
    });
    let response = await f.request(f.authorize());
    for (let i = 0; i < 8; i++) {
      const location = response.headers.get('location');
      if (location) {
        response = await f.request(location);
        continue;
      }
      const html = await response.text();
      const action = /action="([^"]+\/confirm)"/.exec(html)?.[1];
      expect(!!action).toBe(true);
      expect(
        (
          await f.request(action!, {
            method: 'POST',
            headers: { origin: 'http://evil.invalid' },
          })
        ).status,
      ).toBe(403);
      const cancel = await f.request(action!.replace('/confirm', '/abort'), {
        method: 'POST',
        headers: { origin: f.origin },
      });
      const resume = await f.request(cancel.headers.get('location')!);
      expect(resume.headers.get('location')?.includes('error=access_denied')).toBe(true);
      return;
    }
    throw new Error('Consent screen not reached');
  });
  it('honors prompt=none without redirecting to a sign-in screen', async () => {
    const f = await fixture();
    const response = await f.request(f.authorize('app-a', { prompt: 'none' }));
    expect(response.headers.get('location')?.includes('error=login_required')).toBe(true);
  });
  it('requires fresh authentication and rejects a stale completion', async () => {
    const f = await fixture();
    f.setUser({
      userId: 'internal-user',
      authenticatedAt: Math.floor(Date.now() / 1000) - 100,
      method: 'passkey',
      userVerified: true,
    });
    const start = await f.request(f.authorize('app-a', { prompt: 'login' }));
    const interaction = await f.request(start.headers.get('location')!);
    expect(interaction.headers.get('location')?.includes('fresh=1')).toBe(true);
    expect((await f.request(`${start.headers.get('location')}/complete`)).status).toBe(401);
  });
  it('requires authentication to advance after a forced check, even within the same second', async () => {
    const f = await fixture();
    const previous = Date.now() - 10;
    f.setUser({
      userId: 'internal-user',
      authenticatedAt: Math.floor(previous / 1000),
      authenticatedAtMs: previous,
      method: 'passkey',
      userVerified: true,
    });
    const start = await f.request(f.authorize('app-a', { prompt: 'login' }));
    const path = start.headers.get('location')!;
    expect((await f.request(path)).headers.get('location')?.includes('fresh=1')).toBe(true);
    expect((await f.request(path + '/complete')).status).toBe(401);
    const current = Date.now();
    f.setUser({
      userId: 'internal-user',
      authenticatedAt: Math.floor(current / 1000),
      authenticatedAtMs: current,
      method: 'passkey',
      userVerified: true,
    });
    expect((await f.request(path + '/complete')).status).toBe(303);
  });
  it('rejects expired interactions', async () => {
    const f = await fixture();
    const start = await f.request(f.authorize());
    f.db.prepare("UPDATE oidc_records SET expires_at=0 WHERE model='Interaction'").run();
    expect((await f.request(start.headers.get('location')!)).status).toBe(400);
  });
  it('checks shared-session revocation even when the provider remembers a session', async () => {
    const f = await fixture();
    await f.finish(f.authorize());
    f.setUser(null);
    const response = await f.request(f.authorize('app-a', { prompt: 'none' }));
    expect(response.headers.get('location')?.includes('error=login_required')).toBe(true);
  });
  it('accepts a shared authentication within max_age without demanding another passkey', async () => {
    const f = await fixture();
    f.setUser({
      userId: 'internal-user',
      authenticatedAt: Math.floor(Date.now() / 1000) - 30,
      method: 'passkey',
      userVerified: true,
    });
    const start = await f.request(f.authorize('app-a', { max_age: '300' }));
    const interaction = await f.request(start.headers.get('location')!);
    expect(interaction.status).toBe(303);
    expect(interaction.headers.get('location')?.includes('/signin')).toBe(false);
  });
  it('omits unchecked claims and includes only approved sandbox humanity, never an unconsented KYC level', async () => {
    const f = await fixture();
    for (const approved of [false, true]) {
      f.setVerification(
        approved
          ? {
              verified_human: true,
              kyc_level: 'L2',
              verification_sandbox: true,
            }
          : {},
      );
      const callback = await f.finish(f.authorize());
      const tokens = await (await f.exchange(callback.searchParams.get('code')!)).json();
      const info = await (
        await f.request('/oidc/me', {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
      ).json();
      expect(Object.hasOwn(info, 'verified_human')).toBe(approved);
      if (approved) expect(info.verified_human).toBe(true);
      expect(Object.hasOwn(info, 'verification_sandbox')).toBe(approved);
      expect(Object.hasOwn(info, 'kyc_level')).toBe(false);
    }
  });
});
it('persists consumed state, indexes, revocation and subjects across adapter instances', async () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  databases.push(db);
  const storage = createStorage(db),
    adapter = storage.adapter('AuthorizationCode');
  await adapter.upsert('code', { grantId: 'grant', uid: 'uid' }, 60);
  await adapter.consume('code');
  expect(!!(await adapter.findByUid('uid'))?.consumed).toBe(true);
  const subject = storage.subject('user', 'app');
  expect(createStorage(db).subject('user', 'app') === subject).toBe(true);
  await adapter.revokeByGrantId('grant');
  expect(await adapter.find('code')).toBeUndefined();
});

it('leaves schema creation to the logged migration runner', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  createStorage(db);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
  const applied = migrate(db);
  expect(applied).toContain('0004_oidc_initial');
  createStorage(db);
  expect(migrate(db)).toEqual([]);
  expect(
    db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id='0004_oidc_initial'").get(),
  ).toEqual({ n: 1 });
});

it('retains signed sessions, issued tokens, pending codes and pairwise IDs when restarted with the same keys and database', async () => {
  const f = await fixture();
  const callback = await f.finish(f.authorize());
  const jwksBefore = await (await f.request('/oidc/jwks')).json();
  expect(
    jwksBefore.keys.every(
      (key: Record<string, unknown>) => key.n && key.e && !('d' in key) && !('p' in key),
    ),
  ).toBe(true);
  f.restart();
  const response = await f.exchange(callback.searchParams.get('code')!);
  expect(response.status).toBe(200);
  const tokens = await response.json();
  const info = await (
    await f.request('/oidc/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
  ).json();
  f.restart();
  const infoAfter = await (
    await f.request('/oidc/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
  ).json();
  expect(infoAfter.sub === info.sub).toBe(true);
  expect(await (await f.request('/oidc/jwks')).json()).toEqual(jwksBefore);
  const remembered = await f.request(f.authorize('app-a', { prompt: 'none' }));
  expect(new URL(remembered.headers.get('location')!).searchParams.has('code')).toBe(true);
});
