import { describe, expect, it } from 'vitest';
import { mkdtempSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEMO_ISSUER,
  clientList,
  demoClientConfig,
  generateOidcKeys,
  issuerUrl,
  loadOidcConfig,
} from './config.ts';

const clients = [
  {
    client_id: 'chess-demo',
    client_name: 'Chess demo',
    redirect_uris: ['https://chess-demo.withlogin.com/api/login/callback'],
  },
];
const keys = generateOidcKeys();
const hosted = () => ({
  OIDC_ISSUER: DEMO_ISSUER,
  OIDC_CLIENTS: JSON.stringify(clients),
  OIDC_JWKS: JSON.stringify(keys.jwks),
  OIDC_COOKIE_KEYS: JSON.stringify(keys.cookieKeys),
});
describe('public demo OIDC configuration', () => {
  it('accepts only the pinned HTTPS issuer or localhost HTTP /oidc', () => {
    expect(issuerUrl(DEMO_ISSUER).href).toBe(DEMO_ISSUER);
    expect(issuerUrl('http://localhost:5180/oidc').port).toBe('5180');
    for (const value of [
      'https://other.withlogin.com/oidc',
      'https://demo.withlogin.com:8443/oidc',
      'http://demo.withlogin.com/oidc',
      'https://demo.withlogin.com/oidc/',
      'https://demo.withlogin.com/oidc?x=1',
      'https://user@demo.withlogin.com/oidc',
      'http://127.0.0.1:5180/oidc',
      'http://localhost:5180/other',
    ]) {
      expect(() => issuerUrl(value)).toThrow();
    }
  });
  it('requires persistent keys and an explicit client list when hosted', () => {
    for (const variable of ['OIDC_CLIENTS', 'OIDC_JWKS', 'OIDC_COOKIE_KEYS'] as const) {
      const env = hosted();
      delete (env as Partial<typeof env>)[variable];
      expect(() => loadOidcConfig(env)).toThrow();
    }
    expect(loadOidcConfig({}).clients.map((c) => c.client_id)).toContain('chess-local');
  });
  it('reuses configured keys across instances and supports retaining old rotation keys', () => {
    const env = hosted();
    expect(
      JSON.stringify(loadOidcConfig(env).jwks) === JSON.stringify(loadOidcConfig(env).jwks),
    ).toBe(true);
    expect(JSON.stringify(loadOidcConfig(env).cookieKeys) === JSON.stringify(keys.cookieKeys)).toBe(
      true,
    );
    const next = generateOidcKeys();
    env.OIDC_JWKS = JSON.stringify({
      keys: [...next.jwks.keys, ...keys.jwks.keys],
    });
    env.OIDC_COOKIE_KEYS = JSON.stringify([...next.cookieKeys, ...keys.cookieKeys]);
    expect(loadOidcConfig(env).jwks.keys.length).toBe(2);
  });
  it('rejects invalid or partial secrets without including their values in errors', () => {
    const cases = [
      { OIDC_JWKS: 'never-echo-this-value' },
      { OIDC_JWKS: JSON.stringify({ keys: [{ kty: 'RSA' }] }) },
      {
        OIDC_JWKS: JSON.stringify({
          keys: [keys.jwks.keys[0], keys.jwks.keys[0]],
        }),
      },
      { OIDC_COOKIE_KEYS: JSON.stringify(['short', 'also-short']) },
      {
        OIDC_COOKIE_KEYS: JSON.stringify([keys.cookieKeys[0], keys.cookieKeys[0]]),
      },
    ];
    for (const override of cases) {
      let message = '';
      try {
        loadOidcConfig({ ...hosted(), ...override });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/^OIDC_/);
      expect(message.includes('never-echo-this-value')).toBe(false);
    }
    expect(() => loadOidcConfig({ OIDC_JWKS: JSON.stringify(keys.jwks) })).toThrow();
  });
  it('allows exact HTTPS callbacks only when hosted and ignores security-sensitive metadata', () => {
    for (const uri of [
      'http://localhost:5190/callback',
      'http://chess-demo.withlogin.com/callback',
      'https://*.withlogin.com/callback',
      'https://user:password@chess-demo.withlogin.com/callback',
      'https://chess-demo.withlogin.com/callback#fragment',
    ]) {
      expect(() =>
        clientList([{ ...clients[0], redirect_uris: [uri] }], new URL(DEMO_ISSUER)),
      ).toThrow();
    }
    expect(() => clientList([clients[0], clients[0]], new URL(DEMO_ISSUER))).toThrow();
    const result = clientList(
      [
        {
          ...clients[0],
          grant_types: ['implicit'],
          token_endpoint_auth_method: 'client_secret_post',
          client_secret: 'ignored',
        },
      ],
      new URL(DEMO_ISSUER),
    );
    expect(Object.keys(result[0]!)).toEqual(['client_id', 'client_name', 'redirect_uris']);
  });
});
it('generates a new owner-only secrets file without printing values or overwriting it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oidc-generator-'));
  const file = join(dir, 'secrets.json');
  try {
    const run = () =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/server/src/oidc/generate-keys.ts', file],
        { encoding: 'utf8' },
      );
    const first = run();
    expect(first.status).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(first.stdout.includes('OIDC_JWKS')).toBe(false);
    expect(first.stdout.includes('OIDC_COOKIE_KEYS')).toBe(false);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run().status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps hosted second-client opt-in, issuer and origin pinned, with a separate local mode', () => {
  expect(() => demoClientConfig({})).toThrow();
  expect(demoClientConfig({ OIDC_DEV_CLIENT: '1' }).secure).toBe(false);
  const env = {
    OIDC_ISSUER: DEMO_ISSUER,
    OIDC_DEMO_ENABLED: '1',
    OIDC_DEMO_ORIGIN: 'https://second-demo.withlogin.com',
  };
  expect(demoClientConfig(env)).toMatchObject({
    secure: true,
    clientId: 'second-demo',
  });
  for (const origin of [
    'http://second-demo.withlogin.com',
    'https://attacker.invalid',
    'http://localhost:5190',
  ]) {
    expect(() => demoClientConfig({ ...env, OIDC_DEMO_ORIGIN: origin })).toThrow();
  }
  expect(() => demoClientConfig({ ...env, OIDC_DEMO_ENABLED: '' })).toThrow();
});
