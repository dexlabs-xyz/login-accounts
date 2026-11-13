/**
 * TESTNET ONLY. "Get test funds": a signed-in account claims 250 test USDT
 * (plus a small hidden fee reserve) from the pool, once.
 *
 * An exception to D6, by design (team lead, 6 Nov 2026): to send a claim the
 * server is told the account's private 0zk address. It keeps that address in
 * memory only until the transfer is sent, and stores nothing but "this account
 * claimed, when, and the pool's public transaction". Nothing is logged.
 * See docs/design/passkeys.md, "Testnet-only exceptions".
 */
import { Hono } from 'hono';
import type { DB } from '../db.ts';
import { ApiError, readJson } from '../http.ts';
import type { Sessions } from '../passkeys/session.ts';
import { CLAIM_USDT, type TestFundsSender } from './sender.ts';

export const DEFAULT_DAILY_CAP = 100;
const DAY = 24 * 60 * 60_000;

type Row = { user_id: string; status: 'queued' | 'sending' | 'sent'; tx_hash: string | null; created_at: number };

export function testFundsRoutes({
  db,
  sessions,
  sender,
  dailyCap = DEFAULT_DAILY_CAP,
  now = Date.now,
}: {
  db: DB;
  sessions: Sessions;
  sender: TestFundsSender | null;
  dailyCap?: number;
  now?: () => number;
}) {
  const app = new Hono();
  const rowOf = (userId: string) => db.prepare('SELECT * FROM test_fund_claims WHERE user_id = ?').get(userId) as Row | undefined;
  const setStatus = (userId: string, status: Row['status'], txHash: string | null = null) =>
    db.prepare('UPDATE test_fund_claims SET status = ?, tx_hash = ?, updated_at = ? WHERE user_id = ?').run(status, txHash, now(), userId);

  // One claim at a time: they all spend from the same private balance.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (userId: string, railgunAddress: string) => {
    queue = queue.then(async () => {
      try {
        setStatus(userId, 'sending');
        const txHash = await sender!.send(railgunAddress);
        setStatus(userId, 'sent', txHash);
      } catch (e) {
        // Nothing was sent: free the claim so the user can try again. No address in the log.
        db.prepare('DELETE FROM test_fund_claims WHERE user_id = ?').run(userId);
        console.error('Test-funds claim failed:', e instanceof Error ? e.message.slice(0, 120) : 'unknown');
      }
    });
  };

  const view = (userId: string) => {
    const r = rowOf(userId);
    return {
      enabled: true,
      simulation: true,
      amountUsdt: (CLAIM_USDT / 1_000_000n).toString(),
      ready: sender!.ready(),
      status: r?.status ?? null,
      txHash: r?.tx_hash ?? null,
    };
  };

  app.get('/api/test-funds', (c) => {
    const s = sessions.require(c);
    if (!sender) return c.json({ enabled: false });
    return c.json(view(s.user.id));
  });

  app.post('/api/test-funds/claim', async (c) => {
    if (!sender) throw new ApiError(404, 'test-funds-disabled');
    const s = sessions.require(c); // signed in: a verified email and a passkey
    const { railgunAddress } = await readJson<{ railgunAddress?: unknown }>(c);
    if (typeof railgunAddress !== 'string' || !sender.isValidAddress(railgunAddress)) throw new ApiError(400, 'invalid-address');
    if (rowOf(s.user.id)) throw new ApiError(409, 'already-claimed');
    const today = (db.prepare('SELECT count(*) AS n FROM test_fund_claims WHERE created_at > ?').get(now() - DAY) as { n: number }).n;
    if (today >= dailyCap) throw new ApiError(429, 'daily-limit-reached');
    if (!sender.ready()) throw new ApiError(503, 'pool-starting');
    if (!sender.canPay()) throw new ApiError(503, 'pool-empty');

    db.prepare('INSERT INTO test_fund_claims (user_id, status, tx_hash, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)').run(
      s.user.id,
      'queued',
      now(),
      now(),
    );
    enqueue(s.user.id, railgunAddress); // the address lives only in this queued job
    return c.json(view(s.user.id));
  });

  return app;
}
