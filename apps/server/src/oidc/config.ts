/** Explicit allowlist for the unaudited, testnet-only public demo. No deployment secrets are logged. */
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { Configuration, ClientMetadata } from 'oidc-provider';

export const DEMO_ISSUER = 'https://demo.withlogin.com/oidc';
export function issuerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OIDC_ISSUER is invalid.');
  }
  const local =
    url.protocol === 'http:' && url.hostname === 'localhost' && url.pathname === '/oidc';
  if (
    (!local && url.href !== DEMO_ISSUER) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('OIDC_ISSUER must be localhost HTTP /oidc or https://demo.withlogin.com/oidc.');
  }
  return url;
}
export function clientList(input: unknown, issuer: URL): ClientMetadata[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 30)
    throw new Error('OIDC_CLIENTS must be a nonempty client array.');
  const ids = new Set<string>();
  return input.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.client_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(item.client_id) ||
      ids.has(item.client_id)
    ) {
      throw new Error('OIDC_CLIENTS requires unique client IDs.');
    }
    ids.add(item.client_id);
    if (
      typeof item.client_name !== 'string' ||
      !item.client_name.trim() ||
      item.client_name.length > 150 ||
      !Array.isArray(item.redirect_uris) ||
      !item.redirect_uris.length
    ) {
      throw new Error('OIDC_CLIENTS requires a name and exact redirect URIs.');
    }
    const redirect_uris = item.redirect_uris.map((value: unknown) => {
      if (typeof value !== 'string' || value.includes('*'))
        throw new Error('Invalid OIDC redirect URI.');
      let target: URL;
      try {
        target = new URL(value);
      } catch {
        throw new Error('Invalid OIDC redirect URI.');
      }
      const local =
        issuer.protocol === 'http:' &&
        target.protocol === 'http:' &&
        target.hostname === 'localhost';
      if (
        (!local && target.protocol !== 'https:') ||
        target.username ||
        target.password ||
        target.hash
      ) {
        throw new Error('OIDC redirect URIs require HTTPS (localhost HTTP is development-only).');
      }
      return value;
    });
    // Authentication, grants and subject type are controlled by the provider, not by arbitrary JSON metadata.
    return {
      client_id: item.client_id,
      client_name: item.client_name,
      redirect_uris,
    };
  });
}
export type KeyMaterial = {
  jwks: NonNullable<Configuration['jwks']>;
  cookieKeys: string[];
};
export function generateOidcKeys(): KeyMaterial {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    jwks: {
      keys: [
        {
          ...privateKey.export({ format: 'jwk' }),
          kid: randomUUID(),
          alg: 'RS256',
          use: 'sig',
        },
      ],
    },
    cookieKeys: [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')],
  };
}
function json(value: string, variable: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${variable} is not valid JSON.`);
  }
}
function keysFromEnv(env: NodeJS.ProcessEnv, hosted: boolean): KeyMaterial {
  const hasJwks = !!env.OIDC_JWKS?.trim(),
    hasCookies = !!env.OIDC_COOKIE_KEYS?.trim();
  if (!hasJwks && !hasCookies && !hosted) return generateOidcKeys();
  if (!hasJwks || !hasCookies)
    throw new Error('Set both OIDC_JWKS and OIDC_COOKIE_KEYS; hosted demos require stable keys.');
  const jwks = json(env.OIDC_JWKS!, 'OIDC_JWKS') as KeyMaterial['jwks'];
  const cookieKeys = json(env.OIDC_COOKIE_KEYS!, 'OIDC_COOKIE_KEYS');
  const ids = new Set<string>();
  if (!jwks || !Array.isArray(jwks.keys) || !jwks.keys.length)
    throw new Error('OIDC_JWKS requires private RSA signing keys.');
  for (const key of jwks.keys) {
    if (
      !key ||
      key.kty !== 'RSA' ||
      key.alg !== 'RS256' ||
      key.use !== 'sig' ||
      typeof key.kid !== 'string' ||
      !key.kid ||
      ids.has(key.kid) ||
      !key.d
    ) {
      throw new Error('OIDC_JWKS requires unique kid values and RS256 private signing keys.');
    }
    ids.add(key.kid);
    try {
      const parsed = createPrivateKey({ key, format: 'jwk' });
      if (
        parsed.asymmetricKeyType !== 'rsa' ||
        (parsed.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
    } catch {
      throw new Error('OIDC_JWKS contains an invalid RSA private key.');
    }
  }
  if (
    !Array.isArray(cookieKeys) ||
    cookieKeys.length < 2 ||
    cookieKeys.some((key) => typeof key !== 'string' || Buffer.byteLength(key) < 32) ||
    new Set(cookieKeys).size !== cookieKeys.length
  ) {
    throw new Error('OIDC_COOKIE_KEYS requires at least two distinct secrets of 32 or more bytes.');
  }
  return { jwks, cookieKeys };
}
export function loadOidcConfig(env: NodeJS.ProcessEnv = process.env, explicitIssuer?: string) {
  const issuer = issuerUrl(explicitIssuer ?? env.OIDC_ISSUER ?? 'http://localhost:5180/oidc');
  const hosted = issuer.protocol === 'https:';
  const defaults = [
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
  ];
  if (hosted && !env.OIDC_CLIENTS?.trim())
    throw new Error('OIDC_CLIENTS is required for the hosted demo.');
  const clients = clientList(
    env.OIDC_CLIENTS?.trim() ? json(env.OIDC_CLIENTS, 'OIDC_CLIENTS') : defaults,
    issuer,
  );
  return { issuer: issuer.href, clients, ...keysFromEnv(env, hosted) };
}

/** Separate relying-party process; never imported into the shared API. */
export function demoClientConfig(env: NodeJS.ProcessEnv = process.env) {
  const issuer = issuerUrl(env.OIDC_ISSUER ?? 'http://localhost:5180/oidc');
  const secure = issuer.protocol === 'https:';
  const origin = env.OIDC_DEMO_ORIGIN ?? 'http://localhost:5190';
  if (
    secure
      ? env.OIDC_DEMO_ENABLED !== '1' || origin !== 'https://second-demo.withlogin.com'
      : env.OIDC_DEV_CLIENT !== '1' || origin !== 'http://localhost:5190'
  ) {
    throw new Error('Demo client requires explicit opt-in and a matching approved origin/issuer.');
  }
  const clientId = env.OIDC_DEMO_CLIENT_ID ?? (secure ? 'second-demo' : 'chess-local');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) throw new Error('Invalid demo client ID.');
  return { issuer, origin, secure, clientId };
}
