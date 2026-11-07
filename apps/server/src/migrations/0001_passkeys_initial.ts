/**
 * 0001 — passkeys: accounts, passkeys, encrypted vaults, challenges, email
 * codes, sign-up tickets and sessions. Owner: passkeys.
 * IF NOT EXISTS so databases created before migrations existed upgrade cleanly.
 */
import type { Migration } from './index.ts';

export const m0001: Migration = {
  id: '0001_passkeys_initial',
  owner: 'passkeys',
  up(db) {
    db.exec(`
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
  },
};
