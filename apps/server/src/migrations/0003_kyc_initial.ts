/**
 * 0003 — kyc: verification level and attempt state per account, plus the
 * account ↔ Sumsub applicant link (docs/kyc-architecture.md).
 *
 * SIMULATED CONTROLLED ACCESS: `kyc_links` ties an account to a real person at
 * Sumsub. In the full design it lives only in threshold escrow and the user's
 * passkey vault. For the hackathon it is a plain table, never returned by any
 * API and never logged. See the top of kyc/routes.ts.
 */
import type { Migration } from './index.ts';

export const m0003: Migration = {
  id: '0003_kyc_initial',
  owner: 'kyc',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kyc_status (
        user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        level           TEXT,          -- highest level passed: 'L1' | 'L2' | 'L3', NULL = none
        attempt_level   TEXT,          -- level of the latest attempt
        attempt_state   TEXT,          -- 'in-progress' | 'in-review' | 'passed' | 'retry' | 'final'
        attempt_reason  TEXT,          -- 'duplicate' | 'suspected-fraud' | 'selfie' | 'document' | 'other'
        updated_at      INTEGER NOT NULL
      );

      -- SIMULATED CONTROLLED ACCESS (see above). Never exposed or logged.
      CREATE TABLE IF NOT EXISTS kyc_links (
        user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        external_user_id  TEXT NOT NULL UNIQUE,   -- random; what Sumsub knows this account as
        applicant_id      TEXT UNIQUE,            -- Sumsub's ID, learned from a webhook or the widget
        created_at        INTEGER NOT NULL
      );
    `);
  },
};
