/**
 * Server configuration, read from environment variables (see .env.example).
 *
 * WEBAUTHN_RP_ID is `withlogin.com` in production. `localhost` is allowed only
 * for local development (decision D9): browsers treat localhost as a secure
 * origin, so passkeys work without certificates.
 */
export interface Config {
  rpId: string;
  rpName: string;
  /** Exact origins allowed to complete passkey ceremonies. */
  origins: string[];
  port: number;
  dbPath: string;
  /** Dev only: keep sent emails in memory and show them at /api/dev/outbox. */
  devOutbox: boolean;
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rpId = env.WEBAUTHN_RP_ID ?? 'localhost';
  const origins = (env.WEBAUTHN_ORIGINS ?? 'http://localhost:5180')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const devOutbox = env.DEV_OUTBOX === '1';

  if (rpId !== 'localhost' && rpId !== 'withlogin.com' && !rpId.endsWith('.withlogin.com')) {
    throw new Error(`WEBAUTHN_RP_ID must be withlogin.com (or localhost in development), got "${rpId}".`);
  }
  if (devOutbox && rpId !== 'localhost') {
    throw new Error('DEV_OUTBOX shows one-time codes and may only be enabled on localhost.');
  }
  for (const origin of origins) {
    const host = new URL(origin).hostname;
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      throw new Error(`Origin ${origin} does not belong to RP ID ${rpId}.`);
    }
  }

  return {
    rpId,
    rpName: 'Login',
    origins,
    port: Number(env.PORT ?? 8787),
    dbPath: env.DB_PATH ?? ':memory:',
    devOutbox,
    secureCookies: rpId !== 'localhost',
  };
}
