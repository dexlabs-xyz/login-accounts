/** The contract the OIDC component relies on: getSignedInUser(cookieHeader). */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../config.ts';
import { openDb, type DB } from '../db.ts';
import { createSessions, type Sessions } from './session.ts';

let clock: number;
let db: DB;
let sessions: Sessions;
let app: Hono;

beforeEach(() => {
  clock = 1_000_000;
  db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, email, webauthn_user_id, created_at) VALUES ('u1', 'a@example.com', 'h1', 0)").run();
  sessions = createSessions(db, loadConfig({} as NodeJS.ProcessEnv), () => clock);
  app = new Hono();
  app.post('/start', (c) => (sessions.start(c, 'u1'), c.text('ok')));
  app.post('/touch', (c) => (sessions.markAuthenticated(sessions.require(c).token_hash), c.text('ok')));
  app.post('/end', (c) => (sessions.end(c), c.text('ok')));
});

async function signIn() {
  const res = await app.request('/start', { method: 'POST' });
  const setCookie = res.headers.get('set-cookie')!;
  return { setCookie, cookie: setCookie.split(';')[0]! };
}

describe('getSignedInUser', () => {
  it('returns null with no cookie, an unrelated cookie, or a made-up session', () => {
    expect(sessions.getSignedInUser(undefined)).toBeNull();
    expect(sessions.getSignedInUser('theme=dark')).toBeNull();
    expect(sessions.getSignedInUser('login_session=made-up')).toBeNull();
  });

  it('returns the user, when they authenticated, and how', async () => {
    const { cookie } = await signIn();
    expect(sessions.getSignedInUser(`theme=dark; ${cookie}; other=1`)).toEqual({
      userId: 'u1',
      authenticatedAt: 1_000_000,
      method: 'passkey',
      userVerified: true,
    });
  });

  it('authenticatedAt moves only on a passkey check, not with time passing', async () => {
    const { cookie } = await signIn();
    clock += 60_000;
    expect(sessions.getSignedInUser(cookie)!.authenticatedAt).toBe(1_000_000);
    await app.request('/touch', { method: 'POST', headers: { cookie } });
    expect(sessions.getSignedInUser(cookie)!.authenticatedAt).toBe(1_060_000);
  });

  it('returns null after sign-out and after the session expires', async () => {
    const a = await signIn();
    await app.request('/end', { method: 'POST', headers: { cookie: a.cookie } });
    expect(sessions.getSignedInUser(a.cookie)).toBeNull();

    const b = await signIn();
    clock += 7 * 24 * 60 * 60_000 + 1;
    expect(sessions.getSignedInUser(b.cookie)).toBeNull();
  });

  it('cookie is HttpOnly and SameSite=Lax, so it arrives when an app redirects to /oidc/auth', async () => {
    const { setCookie } = await signIn();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});
