/** TESTNET-ONLY gas faucet: every guard, against a fake chain (nothing is sent). */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { loadConfig } from '../config.ts';
import { openDb, type DB } from '../db.ts';
import { ApiError } from '../http.ts';
import { createSessions } from '../passkeys/session.ts';
import { SEPOLIA_CHAIN_ID, testnetGasRoutes, type GasSender } from './routes.ts';

const ADDR = '0x000000000000000000000000000000000000bEEF';
let clock: number;
let db: DB;
let sent: { to: string; amount: bigint }[];
let chainId: bigint;
let balance: bigint;

function fakeSender(): GasSender {
  return {
    chainId: async () => chainId,
    balanceOf: async () => balance,
    send: async (to, amount) => (sent.push({ to, amount }), '0xtxhash'),
  };
}

function build(sender: GasSender | null, limits?: { amountWei: bigint; perUserPerHour: number; globalPerHour: number }) {
  const sessions = createSessions(db, loadConfig({} as NodeJS.ProcessEnv), () => clock);
  const app = new Hono();
  app.onError((err, c) => (err instanceof ApiError ? c.json({ error: err.code }, err.status) : c.json({ error: 'server-error' }, 500)));
  app.post('/start/:user', (c) => (sessions.start(c, c.req.param('user')), c.text('ok')));
  app.route('/', testnetGasRoutes({ sessions, sender, now: () => clock, limits }));
  return app;
}

async function signIn(app: Hono, user = 'u1') {
  const res = await app.request(`/start/${user}`, { method: 'POST' });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

const ask = (app: Hono, cookie: string | null, address: unknown = ADDR) =>
  app.request('/api/testnet-gas', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ address }),
  });

const rowCounts = () => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]));
};

beforeEach(() => {
  clock = 1_000_000;
  db = openDb(':memory:');
  for (const u of ['u1', 'u2']) {
    db.prepare('INSERT INTO users (id, email, webauthn_user_id, created_at) VALUES (?, ?, ?, 0)').run(u, `${u}@example.com`, `h-${u}`);
  }
  sent = [];
  chainId = SEPOLIA_CHAIN_ID;
  balance = 0n;
});

describe('testnet gas faucet (simulation, contradicts D6)', () => {
  it('is off unless a key is configured', async () => {
    const app = build(null);
    expect((await ask(app, await signIn(app))).status).toBe(404);
  });

  it('requires a signed-in user', async () => {
    const app = build(fakeSender());
    expect((await ask(app, null)).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('rejects invalid and zero addresses', async () => {
    const app = build(fakeSender());
    const cookie = await signIn(app);
    for (const bad of ['nope', '0x123', 42, '0x0000000000000000000000000000000000000000']) {
      expect((await ask(app, cookie, bad)).status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses to send on any chain but Sepolia', async () => {
    const app = build(fakeSender());
    chainId = 1n; // mainnet
    const res = await ask(app, await signIn(app));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not-testnet' });
    expect(sent).toHaveLength(0);
  });

  it('sends 0.004 Sepolia ETH and labels the response a simulation', async () => {
    const app = build(fakeSender());
    const res = await ask(app, await signIn(app), ADDR.toLowerCase());
    expect(await res.json()).toEqual({ status: 'sent', txHash: '0xtxhash', amountWei: '4000000000000000', simulation: true });
    expect(sent).toEqual([{ to: ADDR, amount: 4_000_000_000_000_000n }]);
  });

  it('does not send to an address that already has enough', async () => {
    const app = build(fakeSender());
    balance = 4_000_000_000_000_000n;
    expect(await (await ask(app, await signIn(app))).json()).toEqual({ status: 'already-funded' });
    expect(sent).toHaveLength(0);
  });

  it('limits each user per hour, and resets after an hour', async () => {
    const app = build(fakeSender(), { amountWei: 1n, perUserPerHour: 2, globalPerHour: 100 });
    const cookie = await signIn(app);
    expect((await ask(app, cookie)).status).toBe(200);
    expect((await ask(app, cookie)).status).toBe(200);
    expect((await ask(app, cookie)).status).toBe(429);
    clock += 60 * 60_000 + 1;
    expect((await ask(app, cookie)).status).toBe(200);
  });

  it('limits everyone together per hour', async () => {
    const app = build(fakeSender(), { amountWei: 1n, perUserPerHour: 10, globalPerHour: 2 });
    expect((await ask(app, await signIn(app, 'u1'))).status).toBe(200);
    expect((await ask(app, await signIn(app, 'u2'))).status).toBe(200);
    expect((await ask(app, await signIn(app, 'u1'))).status).toBe(429);
  });

  it('stores nothing: no database rows change except the session', async () => {
    const app = build(fakeSender());
    const cookie = await signIn(app);
    const before = rowCounts();
    await ask(app, cookie);
    expect(rowCounts()).toEqual(before);
  });
});
