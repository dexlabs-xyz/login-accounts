/** TESTNET-ONLY test funds: every rule, against a fake pool (nothing is sent). */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../config.ts';
import { openDb, type DB } from '../db.ts';
import { ApiError } from '../http.ts';
import { createSessions } from '../passkeys/session.ts';
import { testFundsRoutes } from './routes.ts';
import type { TestFundsSender } from './sender.ts';

const ZK = '0zk1qyexampleexampleexampleexampleexampleexampleexampleexampleexampleexampleexampleexampleexampleexample';
let db: DB;
let clock: number;
let sent: string[];
let ready: boolean;
let canPay: boolean;
let failNext: boolean;

const fake = (): TestFundsSender => ({
  ready: () => ready,
  canPay: () => canPay,
  isValidAddress: (a) => a.startsWith('0zk1'),
  send: async (to) => {
    if (failNext) {
      failNext = false;
      throw new Error('boom');
    }
    sent.push(to);
    return '0xpooltx';
  },
});

function build(sender: TestFundsSender | null, dailyCap = 100) {
  const sessions = createSessions(db, loadConfig({} as NodeJS.ProcessEnv), () => clock);
  const app = new Hono();
  app.onError((err, c) => (err instanceof ApiError ? c.json({ error: err.code }, err.status) : c.json({ error: 'server-error' }, 500)));
  app.post('/start/:user', (c) => (sessions.start(c, c.req.param('user')), c.text('ok')));
  app.route('/', testFundsRoutes({ db, sessions, sender, dailyCap, now: () => clock }));
  return app;
}
const signIn = async (app: Hono, user = 'u1') => (await app.request(`/start/${user}`, { method: 'POST' })).headers.get('set-cookie')!.split(';')[0]!;
const claim = (app: Hono, cookie: string | null, railgunAddress: unknown = ZK) =>
  app.request('/api/test-funds/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ railgunAddress }),
  });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clock = 1_000_000;
  db = openDb(':memory:');
  for (const u of ['u1', 'u2', 'u3']) db.prepare('INSERT INTO users (id, email, webauthn_user_id, created_at) VALUES (?, ?, ?, 0)').run(u, `${u}@example.com`, `h-${u}`);
  sent = [];
  ready = true;
  canPay = true;
  failNext = false;
});

describe('test funds (testnet only, exception to D6)', () => {
  it('is off unless the pool is configured', async () => {
    const app = build(null);
    expect((await claim(app, await signIn(app))).status).toBe(404);
  });

  it('requires a signed-in account and a valid private address', async () => {
    const app = build(fake());
    expect((await claim(app, null)).status).toBe(401);
    expect((await claim(app, await signIn(app), '0x1234')).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('sends one claim per account, and reports it as sent', async () => {
    const app = build(fake());
    const cookie = await signIn(app);
    expect((await claim(app, cookie)).status).toBe(200);
    await flush();
    expect(sent).toEqual([ZK]);
    const view = await (await app.request('/api/test-funds', { headers: { cookie } })).json();
    expect(view).toMatchObject({ enabled: true, simulation: true, amountUsdt: '1000', status: 'sent', txHash: '0xpooltx' });
    expect((await claim(app, cookie)).status).toBe(409); // never twice
    expect(sent).toHaveLength(1);
  });

  it('stores no private address: only that the account claimed', async () => {
    const app = build(fake());
    await claim(app, await signIn(app));
    await flush();
    const rows = db.prepare('SELECT * FROM test_fund_claims').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain('0zk');
    expect(Object.keys(rows[0]!).sort()).toEqual(['created_at', 'status', 'tx_hash', 'updated_at', 'user_id']);
  });

  it('a failed send frees the claim so the user can try again', async () => {
    const app = build(fake());
    const cookie = await signIn(app);
    failNext = true;
    await claim(app, cookie);
    await flush();
    expect(sent).toEqual([]);
    expect((await (await app.request('/api/test-funds', { headers: { cookie } })).json()).status).toBeNull();
    expect((await claim(app, cookie)).status).toBe(200);
    await flush();
    expect(sent).toEqual([ZK]);
  });

  it('stops at the daily cap for everyone, and resets after a day', async () => {
    const app = build(fake(), 2);
    expect((await claim(app, await signIn(app, 'u1'))).status).toBe(200);
    expect((await claim(app, await signIn(app, 'u2'))).status).toBe(200);
    expect((await claim(app, await signIn(app, 'u3'))).status).toBe(429);
    clock += 24 * 60 * 60_000 + 1;
    expect((await claim(app, await signIn(app, 'u3'))).status).toBe(200);
  });

  it('says so while the pool is starting or empty, without taking the claim', async () => {
    const app = build(fake());
    const cookie = await signIn(app);
    ready = false;
    expect(await (await claim(app, cookie)).json()).toEqual({ error: 'pool-starting' });
    ready = true;
    canPay = false;
    expect(await (await claim(app, cookie)).json()).toEqual({ error: 'pool-empty' });
    canPay = true;
    expect((await claim(app, cookie)).status).toBe(200);
  });
});
