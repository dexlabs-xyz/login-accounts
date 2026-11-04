/**
 * Login accounts API: email verification, passkey sign-up/sign-in, and
 * storage for the encrypted wallet vault. See docs/design/passkeys.md.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Config } from './config.ts';
import type { DB } from './db.ts';

const MINUTE = 60_000;
const CHALLENGE_TTL = 5 * MINUTE;
const CODE_TTL = 10 * MINUTE;
const CODE_RESEND_COOLDOWN = 30_000;
const CODE_MAX_ATTEMPTS = 5;
const TICKET_TTL = 15 * MINUTE;
const SESSION_TTL = 7 * 24 * 60 * MINUTE;
const REAUTH_WINDOW = 5 * MINUTE; // removing a passkey needs a passkey check this recent
const SESSION_COOKIE = 'login_session';

export interface OutboxEmail {
  to: string;
  subject: string;
  body: string;
  sentAt: number;
}

/** How emails leave the server. Resend later; an in-memory outbox in development. */
export interface Mailer {
  send(email: Omit<OutboxEmail, 'sentAt'>): Promise<void>;
}

export function devOutboxMailer(outbox: OutboxEmail[]): Mailer {
  return {
    async send(email) {
      outbox.unshift({ ...email, sentAt: Date.now() });
      outbox.length = Math.min(outbox.length, 50);
    },
  };
}

interface Deps {
  config: Config;
  db: DB;
  mailer: Mailer;
  outbox?: OutboxEmail[];
  now?: () => number;
}

type UserRow = { id: string; email: string; webauthn_user_id: string };
type CredentialRow = {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string;
  backed_up: number;
  wrapped_key: string | null;
  prf_supported?: number | null;
  created_at: number;
  last_used_at: number | null;
};

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const B64U = /^[A-Za-z0-9_-]+$/;

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid-email');
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'invalid-email');
  }
  return email;
}

/** Shape check for EncryptedVault / WrappedKey. The server can't (and mustn't) check more. */
function parseSealed(raw: unknown): { v: number; iv: string; ct: string } {
  const o = raw as { v?: unknown; iv?: unknown; ct?: unknown } | null;
  if (
    !o ||
    typeof o.v !== 'number' ||
    typeof o.iv !== 'string' ||
    typeof o.ct !== 'string' ||
    !B64U.test(o.iv) ||
    !B64U.test(o.ct) ||
    o.iv.length > 64 ||
    o.ct.length > 4096
  ) {
    throw new ApiError(400, 'invalid-ciphertext');
  }
  return { v: o.v, iv: o.iv, ct: o.ct };
}

/**
 * The PRF output is the key to the wallet. The client must strip it before
 * sending a passkey response here. If it ever arrives, refuse loudly so the
 * bug is caught in tests instead of silently tolerated.
 */
function assertNoPrfOutput(response: { clientExtensionResults?: unknown }): void {
  const ext = response.clientExtensionResults as { prf?: { results?: unknown } } | undefined;
  if (ext?.prf?.results !== undefined) throw new ApiError(400, 'prf-output-sent');
}

export function createApp({ config, db, mailer, outbox, now = Date.now }: Deps) {
  const app = new Hono();
  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024 }));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, ...err.extra }, err.status);
    // Don't echo internal errors; they could contain request data.
    console.error('Unhandled error:', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'server-error' }, 500);
  });

  // ---------- helpers ----------

  const json = async <T>(c: Context): Promise<T> => {
    if (!c.req.header('content-type')?.startsWith('application/json')) {
      throw new ApiError(400, 'expected-json'); // also blocks simple cross-site form posts
    }
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new ApiError(400, 'invalid-json');
    }
  };

  const saveChallenge = (challenge: string, purpose: string, userId: string | null) => {
    const id = token();
    db.prepare('INSERT INTO challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      challenge,
      purpose,
      userId,
      now() + CHALLENGE_TTL,
    );
    return id;
  };

  /** Single use: a challenge is deleted the moment it's read, so replays fail. */
  const consumeChallenge = (id: unknown, purpose: string, userId: string | null): string => {
    if (typeof id !== 'string') throw new ApiError(400, 'invalid-ceremony');
    const row = db.prepare('DELETE FROM challenges WHERE id = ? RETURNING *').get(id) as
      | { challenge: string; purpose: string; user_id: string | null; expires_at: number }
      | undefined;
    if (!row || row.purpose !== purpose || row.user_id !== userId) throw new ApiError(400, 'invalid-ceremony');
    if (row.expires_at < now()) throw new ApiError(400, 'ceremony-expired');
    return row.challenge;
  };

  const startSession = (c: Context, userId: string) => {
    const t = token();
    db.prepare('INSERT INTO sessions (token_hash, user_id, auth_at, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(t),
      userId,
      now(),
      now() + SESSION_TTL,
    );
    setCookie(c, SESSION_COOKIE, t, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'Strict',
      path: '/',
      maxAge: SESSION_TTL / 1000,
    });
  };

  const session = (c: Context) => {
    const t = getCookie(c, SESSION_COOKIE);
    if (!t) throw new ApiError(401, 'signed-out');
    const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(t)) as
      | { token_hash: string; user_id: string; auth_at: number; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) throw new ApiError(401, 'signed-out');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow;
    return { ...row, user };
  };

  const credentialsOf = (userId: string) =>
    db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY created_at').all(userId) as CredentialRow[];

  const publicCredential = (r: CredentialRow) => ({
    id: r.id,
    deviceType: r.device_type,
    backedUp: r.backed_up === 1,
    canOpenWallet: r.wrapped_key !== null,
    /** null = not known yet (e.g. added while the wallet was locked). */
    prfSupported: r.prf_supported == null ? null : r.prf_supported === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  });

  const registrationOptions = (user: { email: string; webauthnUserId: string }, exclude: CredentialRow[]) =>
    generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: user.email,
      userID: Buffer.from(user.webauthnUserId, 'base64url'),
      attestationType: 'none',
      excludeCredentials: exclude.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256 (Windows Hello)
    });

  const verifyRegistration = async (response: RegistrationResponseJSON, expectedChallenge: string) => {
    assertNoPrfOutput(response);
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    }).catch(() => ({ verified: false as const }));
    if (!result.verified) throw new ApiError(400, 'passkey-not-verified');
    return result.registrationInfo;
  };

  const insertCredential = (
    userId: string,
    info: Awaited<ReturnType<typeof verifyRegistration>>,
  ): CredentialRow => {
    const row: CredentialRow = {
      id: info.credential.id,
      user_id: userId,
      public_key: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ? JSON.stringify(info.credential.transports) : null,
      device_type: info.credentialDeviceType,
      backed_up: info.credentialBackedUp ? 1 : 0,
      wrapped_key: null,
      created_at: now(),
      last_used_at: now(),
    };
    db.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, device_type, backed_up, wrapped_key, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.user_id,
      row.public_key,
      row.counter,
      row.transports,
      row.device_type,
      row.backed_up,
      row.wrapped_key,
      row.created_at,
      row.last_used_at,
    );
    return row;
  };

  // ---------- email verification (D2) ----------

  app.post('/api/email/start', async (c) => {
    const email = normalizeEmail((await json<{ email?: unknown }>(c)).email);
    const existing = db.prepare('SELECT sent_at FROM email_codes WHERE email = ?').get(email) as
      | { sent_at: number }
      | undefined;
    if (existing && now() - existing.sent_at < CODE_RESEND_COOLDOWN) {
      throw new ApiError(429, 'wait-before-resending', {
        retryAfterMs: CODE_RESEND_COOLDOWN - (now() - existing.sent_at),
      });
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    db.prepare(
      `INSERT INTO email_codes (email, code_hash, attempts, sent_at, expires_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0, sent_at = excluded.sent_at, expires_at = excluded.expires_at`,
    ).run(email, sha256(`${email}:${code}`), now(), now() + CODE_TTL);
    // Same response whether or not the email has an account, so this can't be used to probe.
    await mailer.send({
      to: email,
      subject: `${code} is your Login code`,
      body: `Your Login code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
    });
    return c.json({ ok: true });
  });

  app.post('/api/email/verify', async (c) => {
    const body = await json<{ email?: unknown; code?: unknown }>(c);
    const email = normalizeEmail(body.email);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    const row = db.prepare('SELECT * FROM email_codes WHERE email = ?').get(email) as
      | { code_hash: string; attempts: number; expires_at: number }
      | undefined;
    if (!row) throw new ApiError(400, 'no-code-sent');
    if (row.expires_at < now()) {
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
      throw new ApiError(400, 'code-expired');
    }
    const ok =
      /^\d{6}$/.test(code) &&
      timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(sha256(`${email}:${code}`), 'hex'));
    if (!ok) {
      const attempts = row.attempts + 1;
      if (attempts >= CODE_MAX_ATTEMPTS) {
        db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
        throw new ApiError(400, 'too-many-attempts');
      }
      db.prepare('UPDATE email_codes SET attempts = ? WHERE email = ?').run(attempts, email);
      throw new ApiError(400, 'wrong-code', { attemptsLeft: CODE_MAX_ATTEMPTS - attempts });
    }
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);

    // The email is proven, so it's safe to say whether it has an account.
    // Proving the email never signs anyone in: that always needs a passkey.
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return c.json({ status: 'existing' as const });
    }
    const ticket = token();
    db.prepare('INSERT INTO signup_tickets (token_hash, email, webauthn_user_id, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(ticket),
      email,
      randomBytes(32).toString('base64url'),
      now() + TICKET_TTL,
    );
    return c.json({ status: 'new' as const, ticket });
  });

  // ---------- sign-up ----------

  const ticketRow = (ticket: unknown) => {
    if (typeof ticket !== 'string') throw new ApiError(400, 'invalid-ticket');
    const row = db.prepare('SELECT * FROM signup_tickets WHERE token_hash = ?').get(sha256(ticket)) as
      | { token_hash: string; email: string; webauthn_user_id: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at < now()) throw new ApiError(400, 'signup-expired');
    return row;
  };

  app.post('/api/register/options', async (c) => {
    const t = ticketRow((await json<{ ticket?: unknown }>(c)).ticket);
    const options = await registrationOptions({ email: t.email, webauthnUserId: t.webauthn_user_id }, []);
    return c.json({ ceremonyId: saveChallenge(options.challenge, `register:${t.token_hash}`, null), options });
  });

  app.post('/api/register/verify', async (c) => {
    const body = await json<{ ticket?: unknown; ceremonyId?: unknown; response?: RegistrationResponseJSON }>(c);
    const t = ticketRow(body.ticket);
    const challenge = consumeChallenge(body.ceremonyId, `register:${t.token_hash}`, null);
    if (!body.response) throw new ApiError(400, 'missing-response');
    const info = await verifyRegistration(body.response, challenge);

    const userId = randomBytes(16).toString('base64url');
    db.exec('BEGIN');
    try {
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(t.email)) throw new ApiError(409, 'email-taken');
      db.prepare('INSERT INTO users (id, email, webauthn_user_id, created_at) VALUES (?, ?, ?, ?)').run(
        userId,
        t.email,
        t.webauthn_user_id,
        now(),
      );
      const cred = insertCredential(userId, info);
      db.prepare('DELETE FROM signup_tickets WHERE token_hash = ?').run(t.token_hash);
      db.exec('COMMIT');
      startSession(c, userId);
      return c.json({ userId, credential: publicCredential(cred) });
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  });

  // ---------- sign-in (also used to unlock the wallet and confirm sends, D5) ----------

  app.post('/api/login/options', async (c) => {
    // Discoverable passkeys: no username needed, the passkey says who you are.
    const options = await generateAuthenticationOptions({ rpID: config.rpId, userVerification: 'required' });
    return c.json({ ceremonyId: saveChallenge(options.challenge, 'login', null), options });
  });

  app.post('/api/login/verify', async (c) => {
    const body = await json<{ ceremonyId?: unknown; response?: AuthenticationResponseJSON }>(c);
    const expectedChallenge = consumeChallenge(body.ceremonyId, 'login', null);
    const response = body.response;
    if (!response || typeof response.id !== 'string') throw new ApiError(400, 'missing-response');
    assertNoPrfOutput(response);

    const cred = db.prepare('SELECT * FROM credentials WHERE id = ?').get(response.id) as CredentialRow | undefined;
    // The device has a passkey we don't know (e.g. deleted here). The client
    // tells the browser so it can hide it (signalUnknownCredential).
    if (!cred) throw new ApiError(404, 'unknown-credential', { credentialId: response.id });

    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
    if (!result.verified || !result.authenticationInfo) throw new ApiError(400, 'passkey-not-verified');

    const info = result.authenticationInfo;
    // Synced passkeys can start or stop being backed up; keep the flags current for D4.
    db.prepare('UPDATE credentials SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ? WHERE id = ?').run(
      info.newCounter,
      info.credentialDeviceType,
      info.credentialBackedUp ? 1 : 0,
      now(),
      cred.id,
    );

    // Replace any existing session (it may belong to someone else on a shared computer).
    const old = getCookie(c, SESSION_COOKIE);
    if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(old));
    startSession(c, cred.user_id);

    const vault = db.prepare('SELECT vault FROM vaults WHERE user_id = ?').get(cred.user_id) as
      | { vault: string }
      | undefined;
    return c.json({
      userId: cred.user_id,
      credentialId: cred.id,
      // Ciphertext only. The client opens it with this passkey's PRF output.
      vault: vault ? JSON.parse(vault.vault) : null,
      wrapped: cred.wrapped_key ? JSON.parse(cred.wrapped_key) : null,
    });
  });

  app.post('/api/logout', (c) => {
    const t = getCookie(c, SESSION_COOKIE);
    if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---------- account ----------

  app.get('/api/me', (c) => {
    const s = session(c);
    const hasVault = !!db.prepare('SELECT 1 FROM vaults WHERE user_id = ?').get(s.user.id);
    return c.json({
      userId: s.user.id,
      email: s.user.email,
      hasVault,
      credentials: credentialsOf(s.user.id).map(publicCredential),
    });
  });

  /** First-time wallet setup, from a device whose passkey supports PRF (D3, D7). */
  app.put('/api/vault', async (c) => {
    const s = session(c);
    const body = await json<{ credentialId?: unknown; vault?: unknown; wrapped?: unknown }>(c);
    const vault = parseSealed(body.vault);
    const wrapped = parseSealed(body.wrapped);
    const cred = credentialsOf(s.user.id).find((r) => r.id === body.credentialId);
    if (!cred) throw new ApiError(404, 'unknown-credential');

    db.exec('BEGIN');
    try {
      // Never overwrite: replacing a vault would destroy the user's wallet.
      if (db.prepare('SELECT 1 FROM vaults WHERE user_id = ?').get(s.user.id)) throw new ApiError(409, 'vault-exists');
      db.prepare('INSERT INTO vaults (user_id, vault, created_at) VALUES (?, ?, ?)').run(
        s.user.id,
        JSON.stringify(vault),
        now(),
      );
      db.prepare('UPDATE credentials SET wrapped_key = ?, prf_supported = 1 WHERE id = ?').run(JSON.stringify(wrapped), cred.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return c.json({ ok: true });
  });

  /** Fetch the vault again, used right after setup to prove the round trip works (D3). */
  app.get('/api/vault', (c) => {
    const s = session(c);
    const credentialId = c.req.query('credentialId');
    const cred = credentialsOf(s.user.id).find((r) => r.id === credentialId);
    const vault = db.prepare('SELECT vault FROM vaults WHERE user_id = ?').get(s.user.id) as
      | { vault: string }
      | undefined;
    if (!cred || !vault) throw new ApiError(404, 'not-found');
    return c.json({ vault: JSON.parse(vault.vault), wrapped: cred.wrapped_key ? JSON.parse(cred.wrapped_key) : null });
  });

  // ---------- managing passkeys (D4) ----------

  app.post('/api/passkeys/options', async (c) => {
    const s = session(c);
    const options = await registrationOptions(
      { email: s.user.email, webauthnUserId: s.user.webauthn_user_id },
      credentialsOf(s.user.id),
    );
    return c.json({ ceremonyId: saveChallenge(options.challenge, 'add-passkey', s.user.id), options });
  });

  app.post('/api/passkeys/verify', async (c) => {
    const s = session(c);
    const body = await json<{ ceremonyId?: unknown; response?: RegistrationResponseJSON }>(c);
    const challenge = consumeChallenge(body.ceremonyId, 'add-passkey', s.user.id);
    if (!body.response) throw new ApiError(400, 'missing-response');
    const info = await verifyRegistration(body.response, challenge);
    if (db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(info.credential.id)) {
      throw new ApiError(409, 'passkey-exists');
    }
    const cred = insertCredential(s.user.id, info);
    db.prepare('UPDATE sessions SET auth_at = ? WHERE token_hash = ?').run(now(), s.token_hash);
    return c.json({ credential: publicCredential(cred) });
  });

  /** Let a newly added passkey open the wallet too (D1). Set once, never overwritten. */
  app.put('/api/passkeys/:id/wrapped', async (c) => {
    const s = session(c);
    const wrapped = parseSealed((await json<{ wrapped?: unknown }>(c)).wrapped);
    const cred = credentialsOf(s.user.id).find((r) => r.id === c.req.param('id'));
    if (!cred) throw new ApiError(404, 'unknown-credential');
    if (!db.prepare('SELECT 1 FROM vaults WHERE user_id = ?').get(s.user.id)) throw new ApiError(409, 'no-vault');
    if (cred.wrapped_key) throw new ApiError(409, 'already-set');
    db.prepare('UPDATE credentials SET wrapped_key = ?, prf_supported = 1 WHERE id = ?').run(JSON.stringify(wrapped), cred.id);
    return c.json({ ok: true });
  });

  /**
   * Record that this passkey's storage can't produce the PRF secret, so the UI
   * can say why it can't open the wallet. Only for passkeys without a wrapped key.
   */
  app.put('/api/passkeys/:id/prf-unsupported', (c) => {
    const s = session(c);
    const cred = credentialsOf(s.user.id).find((r) => r.id === c.req.param('id'));
    if (!cred) throw new ApiError(404, 'unknown-credential');
    if (cred.wrapped_key) throw new ApiError(409, 'already-set');
    db.prepare('UPDATE credentials SET prf_supported = 0 WHERE id = ?').run(cred.id);
    return c.json({ ok: true });
  });

  app.delete('/api/passkeys/:id', (c) => {
    const s = session(c);
    if (now() - s.auth_at > REAUTH_WINDOW) throw new ApiError(403, 'reauth-required');
    const creds = credentialsOf(s.user.id);
    const cred = creds.find((r) => r.id === c.req.param('id'));
    if (!cred) throw new ApiError(404, 'unknown-credential');
    if (creds.length === 1) throw new ApiError(409, 'last-passkey');
    const hasVault = !!db.prepare('SELECT 1 FROM vaults WHERE user_id = ?').get(s.user.id);
    const walletOpeners = creds.filter((r) => r.wrapped_key !== null);
    if (hasVault && cred.wrapped_key && walletOpeners.length === 1) {
      // Deleting it would lock the money away forever.
      throw new ApiError(409, 'last-wallet-passkey');
    }
    db.prepare('DELETE FROM credentials WHERE id = ?').run(cred.id);
    return c.json({ ok: true, credentialId: cred.id });
  });

  // ---------- development only ----------

  if (config.devOutbox && outbox) {
    app.get('/api/dev/outbox', (c) => c.json({ emails: outbox }));
  }

  return app;
}
