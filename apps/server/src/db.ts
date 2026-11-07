/**
 * The shared database. Owned jointly; schema changes go through migrations/.
 *
 * What the passkeys tables let this server see (decision D6), and nothing more:
 *   - a random user ID and the user's email
 *   - passkey public keys, credential IDs, counters and sync flags
 *   - the encrypted vault and wrapped keys, which it cannot open
 * It never sees the recovery phrase, PRF outputs, Railgun addresses or balances.
 *
 * Uses Node's built-in SQLite (node:sqlite) to avoid a native dependency.
 * It is marked experimental in Node 22; fine for the hackathon, revisit later.
 */
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations/index.ts';

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
