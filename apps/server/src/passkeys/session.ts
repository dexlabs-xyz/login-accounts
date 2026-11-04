/**
 * Login sessions. Owned by the passkeys component.
 *
 * Contract for other components (OIDC): call getSignedInUser(cookieHeader).
 * Don't read the sessions table or the cookie yourself.
 *
 * The cookie is SameSite=Lax so it arrives on top-level navigations from other
 * sites (an app sending the user to /oidc/auth). Cross-site POSTs still can't
 * use it, and every state-changing route requires a JSON body anyway.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.ts';
import type { DB } from '../db.ts';
import { ApiError } from '../http.ts';

export const SESSION_COOKIE = 'login_session';
const SESSION_TTL = 7 * 24 * 60 * 60_000;

/** What OIDC needs to know about the person behind a request. */
export interface SignedInUser {
  /** Stable internal user ID (users.id). Never send it to apps; derive a per-app ID. */
  userId: string;
  /** Last successful passkey check, in ms since epoch. Only a passkey check moves it. */
  authenticatedAt: number;
  method: 'passkey';
  /** Always true: Login requires Face ID / fingerprint / PIN for every passkey check. */
  userVerified: true;
}

type SessionRow = { token_hash: string; user_id: string; auth_at: number; expires_at: number };
type UserRow = { id: string; email: string; webauthn_user_id: string };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function createSessions(db: DB, config: Config, now: () => number = Date.now) {
  const row = (token: string | undefined): SessionRow | null => {
    if (!token) return null;
    const r = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)) as SessionRow | undefined;
    return r && r.expires_at >= now() ? r : null;
  };

  return {
    /**
     * The signed-in user for a request, or null. Pass the raw Cookie header
     * (works with Hono, Koa/oidc-provider and plain Node requests alike).
     */
    getSignedInUser(cookieHeader: string | null | undefined): SignedInUser | null {
      const r = row(readCookie(cookieHeader, SESSION_COOKIE));
      return r ? { userId: r.user_id, authenticatedAt: r.auth_at, method: 'passkey', userVerified: true } : null;
    },

    /** Start a session after a successful passkey check. */
    start(c: Context, userId: string): void {
      const t = randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions (token_hash, user_id, auth_at, expires_at) VALUES (?, ?, ?, ?)').run(
        sha256(t),
        userId,
        now(),
        now() + SESSION_TTL,
      );
      setCookie(c, SESSION_COOKIE, t, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_TTL / 1000,
      });
    },

    /** The current session, or 401. For passkey routes. */
    require(c: Context) {
      const r = row(getCookie(c, SESSION_COOKIE));
      if (!r) throw new ApiError(401, 'signed-out');
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id) as UserRow;
      return { ...r, user };
    },

    /** Record a passkey check made inside an existing session (e.g. adding a passkey). */
    markAuthenticated(tokenHash: string): void {
      db.prepare('UPDATE sessions SET auth_at = ? WHERE token_hash = ?').run(now(), tokenHash);
    },

    /** End the current session (sign out, or before starting a new one). */
    end(c: Context): void {
      const t = getCookie(c, SESSION_COOKIE);
      if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;
