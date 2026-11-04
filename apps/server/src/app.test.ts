/**
 * API tests that don't need a real passkey. Full passkey ceremonies (with
 * Chrome's virtual authenticator) live in e2e/.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, devOutboxMailer, type OutboxEmail } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';

let clock = 1_000_000;
let outbox: OutboxEmail[];
let app: ReturnType<typeof createApp>;

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const lastCode = () => /\b(\d{6})\b/.exec(outbox[0]!.subject)![1]!;

beforeEach(() => {
  clock = 1_000_000;
  outbox = [];
  const config = loadConfig({ DEV_OUTBOX: '1' } as NodeJS.ProcessEnv);
  app = createApp({ config, db: openDb(':memory:'), mailer: devOutboxMailer(outbox), outbox, now: () => clock });
});

describe('config', () => {
  it('refuses a passkey domain other than withlogin.com or localhost', () => {
    expect(() => loadConfig({ WEBAUTHN_RP_ID: 'evil.com', WEBAUTHN_ORIGINS: 'https://evil.com' } as NodeJS.ProcessEnv)).toThrow();
  });
  it('refuses the dev outbox outside localhost', () => {
    expect(() =>
      loadConfig({ WEBAUTHN_RP_ID: 'withlogin.com', WEBAUTHN_ORIGINS: 'https://withlogin.com', DEV_OUTBOX: '1' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
  it('refuses origins that do not belong to the RP ID', () => {
    expect(() => loadConfig({ WEBAUTHN_ORIGINS: 'https://withlogin.com.evil.com' } as NodeJS.ProcessEnv)).toThrow();
  });
});

describe('email codes (D2)', () => {
  it('sends a 6-digit code to the outbox', async () => {
    const res = await post('/api/email/start', { email: '  Ada@Example.com ' });
    expect(res.status).toBe(200);
    expect(outbox[0]!.to).toBe('ada@example.com');
    expect(lastCode()).toMatch(/^\d{6}$/);
  });

  it('answers the same for new and existing emails', async () => {
    const a = await (await post('/api/email/start', { email: 'new@example.com' })).json();
    const b = await (await post('/api/email/start', { email: 'other@example.com' })).json();
    expect(a).toEqual(b);
  });

  it('a correct code for a new email returns a sign-up ticket', async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    const res = await post('/api/email/verify', { email: 'ada@example.com', code: lastCode() });
    const body = await res.json();
    expect(body.status).toBe('new');
    expect(typeof body.ticket).toBe('string');
  });

  it('a code works only once', async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    const code = lastCode();
    await post('/api/email/verify', { email: 'ada@example.com', code });
    const again = await post('/api/email/verify', { email: 'ada@example.com', code });
    expect(again.status).toBe(400);
  });

  it('locks the code after 5 wrong tries', async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      const r = await (await post('/api/email/verify', { email: 'ada@example.com', code: wrong })).json();
      expect(r).toMatchObject({ error: 'wrong-code', attemptsLeft: 4 - i });
    }
    const fifth = await (await post('/api/email/verify', { email: 'ada@example.com', code: wrong })).json();
    expect(fifth.error).toBe('too-many-attempts');
    const right = await (await post('/api/email/verify', { email: 'ada@example.com', code })).json();
    expect(right.error).toBe('no-code-sent');
  });

  it('expires codes after 10 minutes', async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    clock += 10 * 60_000 + 1;
    const r = await (await post('/api/email/verify', { email: 'ada@example.com', code: lastCode() })).json();
    expect(r.error).toBe('code-expired');
  });

  it('rate-limits resending to once per 30 seconds', async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    expect((await post('/api/email/start', { email: 'ada@example.com' })).status).toBe(429);
    clock += 30_001;
    expect((await post('/api/email/start', { email: 'ada@example.com' })).status).toBe(200);
  });

  it('rejects malformed emails', async () => {
    expect((await post('/api/email/start', { email: 'not-an-email' })).status).toBe(400);
  });
});

describe('passkey ceremonies', () => {
  const ticket = async () => {
    await post('/api/email/start', { email: 'ada@example.com' });
    return (await (await post('/api/email/verify', { email: 'ada@example.com', code: lastCode() })).json()).ticket;
  };

  it('sign-up options require a discoverable passkey with user verification', async () => {
    const { options } = await (await post('/api/register/options', { ticket: await ticket() })).json();
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.rp.id).toBe('localhost');
    expect(options.user.name).toBe('ada@example.com');
  });

  it('sign-up needs a valid ticket', async () => {
    expect((await post('/api/register/options', { ticket: 'made-up' })).status).toBe(400);
  });

  it('tickets expire', async () => {
    const t = await ticket();
    clock += 15 * 60_000 + 1;
    expect((await post('/api/register/options', { ticket: t })).status).toBe(400);
  });

  it('refuses any response that carries the PRF output (it must stay on the device)', async () => {
    const { ceremonyId } = await (await post('/api/login/options', {})).json();
    const res = await post('/api/login/verify', {
      ceremonyId,
      response: { id: 'x', rawId: 'x', type: 'public-key', response: {}, clientExtensionResults: { prf: { results: { first: 'AAAA' } } } },
    });
    expect(await res.json()).toEqual({ error: 'prf-output-sent' });
  });

  it('challenges are single-use (replay fails)', async () => {
    const { ceremonyId } = await (await post('/api/login/options', {})).json();
    const fake = { id: 'unknown', rawId: 'unknown', type: 'public-key', response: {}, clientExtensionResults: {} };
    expect((await (await post('/api/login/verify', { ceremonyId, response: fake })).json()).error).toBe('unknown-credential');
    expect((await (await post('/api/login/verify', { ceremonyId, response: fake })).json()).error).toBe('invalid-ceremony');
  });

  it('challenges expire after 5 minutes', async () => {
    const { ceremonyId } = await (await post('/api/login/options', {})).json();
    clock += 5 * 60_000 + 1;
    const r = await post('/api/login/verify', { ceremonyId, response: { id: 'x', clientExtensionResults: {} } });
    expect((await r.json()).error).toBe('ceremony-expired');
  });

  it('tells the client about passkeys it does not know (for signalUnknownCredential)', async () => {
    const { ceremonyId } = await (await post('/api/login/options', {})).json();
    const r = await post('/api/login/verify', { ceremonyId, response: { id: 'gone', clientExtensionResults: {} } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown-credential', credentialId: 'gone' });
  });
});

describe('access control', () => {
  it('account and vault endpoints need a session', async () => {
    expect((await app.request('/api/me')).status).toBe(401);
    expect((await app.request('/api/vault?credentialId=x')).status).toBe(401);
    const put = await app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(put.status).toBe(401);
  });

  it('rejects non-JSON posts (blocks cross-site form submissions)', async () => {
    const r = await app.request('/api/email/start', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' });
    expect(r.status).toBe(400);
  });
});
