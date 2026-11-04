/**
 * Storage. What this server can see (decision D6), and nothing more:
 *   - a random user ID and the user's email
 *   - passkey public keys, credential IDs, counters and sync flags
 *   - the encrypted vault and wrapped keys, which it cannot open
 * It never sees the recovery phrase, PRF outputs, Railgun addresses or balances.
 *
 * Uses Node's built-in SQLite (node:sqlite) to avoid a native dependency.
 * It is marked experimental in Node 22; fine for the hackathon, revisit later.
 */
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,         -- random, never derived from email
      email           TEXT NOT NULL UNIQUE,
      webauthn_user_id TEXT NOT NULL UNIQUE,    -- random user handle given to passkeys
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id            TEXT PRIMARY KEY,           -- base64url credential ID
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      public_key    BLOB NOT NULL,
      counter       INTEGER NOT NULL,
      transports    TEXT,                       -- JSON array
      device_type   TEXT NOT NULL,              -- 'singleDevice' | 'multiDevice'
      backed_up     INTEGER NOT NULL,           -- 1 if synced (iCloud, Google, ...)
      wrapped_key   TEXT,                       -- JSON WrappedKey, null if this passkey can't open the wallet
      created_at    INTEGER NOT NULL,
      last_used_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS vaults (
      user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      vault       TEXT NOT NULL,                -- JSON EncryptedVault
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS challenges (
      id          TEXT PRIMARY KEY,
      challenge   TEXT NOT NULL,
      purpose     TEXT NOT NULL,                -- 'register' | 'login' | 'add-passkey'
      user_id     TEXT,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_codes (
      email       TEXT PRIMARY KEY,
      code_hash   TEXT NOT NULL,
      attempts    INTEGER NOT NULL,
      sent_at     INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signup_tickets (
      token_hash        TEXT PRIMARY KEY,
      email             TEXT NOT NULL,
      webauthn_user_id  TEXT NOT NULL,
      expires_at        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      auth_at     INTEGER NOT NULL,             -- last passkey check, for sensitive actions
      expires_at  INTEGER NOT NULL
    );
  `);
  // Added after the first schema: what we know about this passkey's PRF support.
  // NULL = unknown, 0 = its storage can't open wallets, 1 = it can.
  const cols = db.prepare('PRAGMA table_info(credentials)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'prf_supported')) {
    db.exec('ALTER TABLE credentials ADD COLUMN prf_supported INTEGER');
    db.exec('UPDATE credentials SET prf_supported = 1 WHERE wrapped_key IS NOT NULL');
  }
  return db;
}
