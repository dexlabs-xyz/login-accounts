import type { Migration } from './index.ts';

export const m0004: Migration = {
  id: '0004_oidc_initial',
  owner: 'oidc',
  up(db) {
    db.exec(`
-- Component-owned migration; no passkey tables are changed.
CREATE TABLE IF NOT EXISTS oidc_records (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (model, id)
);
CREATE INDEX IF NOT EXISTS oidc_records_expiry ON oidc_records(expires_at);
CREATE TABLE IF NOT EXISTS oidc_subjects (
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  subject TEXT NOT NULL UNIQUE,
  PRIMARY KEY (account_id, client_id)
);
`);
  },
};
