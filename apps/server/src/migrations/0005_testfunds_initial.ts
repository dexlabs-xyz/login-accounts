/**
 * 0005 — test funds (TESTNET ONLY): one row per account that claimed test
 * USDT from the pool. Deliberately stores no private (0zk) address: only that
 * this account claimed, when, and how it went (an exception to D6, see
 * docs/design/passkeys.md, "Testnet-only exceptions").
 */
import type { Migration } from './index.ts';

export const m0005: Migration = {
  id: '0005_testfunds_initial',
  owner: 'test-funds',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_fund_claims (
        user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,   -- 'queued' | 'sending' | 'sent'
        tx_hash     TEXT,            -- the pool's public transaction (shows only that a private transfer happened)
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS test_fund_claims_created ON test_fund_claims(created_at);
    `);
  },
};
