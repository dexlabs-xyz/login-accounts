/**
 * Database migrations, applied in order, each exactly once.
 *
 * Rules (shared by the passkeys and OIDC teams):
 * - Never edit a migration that has been merged. Add a new one.
 * - Number them in order: NNNN_<owner>_<what>.ts, then list them below.
 * - Each component owns its tables. OIDC tables are prefixed `oidc_`.
 *   Never change another component's tables; ask its owner.
 */
import type { DB } from '../db.ts';
import { m0001 } from './0001_passkeys_initial.ts';
import { m0002 } from './0002_passkeys_prf_supported.ts';
import { m0003 } from './0003_kyc_initial.ts';

import { m0004 } from './0004_oidc_initial.ts';

export interface Migration {
  id: string;
  owner: 'passkeys' | 'oidc' | 'kyc' | 'shared';
  up(db: DB): void;
}

export const migrations: Migration[] = [m0001, m0002, m0003, m0004];

export function migrate(db: DB, list: Migration[] = migrations): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id));
  const applied: string[] = [];
  for (const m of list) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return applied;
}
