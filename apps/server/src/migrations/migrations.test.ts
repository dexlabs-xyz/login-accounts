import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate, type Migration } from './index.ts';

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe('migrations', () => {
  it('builds a fresh database and records each migration once', () => {
    const db = new DatabaseSync(':memory:');
    expect(migrate(db)).toEqual(['0001_passkeys_initial', '0002_passkeys_prf_supported']);
    expect(migrate(db)).toEqual([]); // second run does nothing
    expect(tables(db)).toEqual(expect.arrayContaining(['users', 'credentials', 'vaults', 'sessions', 'schema_migrations']));
  });

  it('upgrades a database created before migrations existed, keeping its data', () => {
    const db = new DatabaseSync(':memory:');
    // The original schema, without prf_supported or schema_migrations.
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, webauthn_user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE credentials (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
        transports TEXT, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL, wrapped_key TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER);
      INSERT INTO users VALUES ('u1', 'a@example.com', 'h1', 0);
      INSERT INTO credentials VALUES ('c1', 'u1', x'00', 0, NULL, 'multiDevice', 1, '{"v":1}', 0, NULL);
      INSERT INTO credentials VALUES ('c2', 'u1', x'00', 0, NULL, 'singleDevice', 0, NULL, 0, NULL);
    `);
    migrate(db);
    const rows = db.prepare('SELECT id, prf_supported FROM credentials ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'c1', prf_supported: 1 }, // had a wrapped key, so it can open the wallet
      { id: 'c2', prf_supported: null }, // unknown
    ]);
    expect(db.prepare('SELECT email FROM users').get()).toEqual({ email: 'a@example.com' });
  });

  it('a failing migration changes nothing and is not recorded', () => {
    const db = new DatabaseSync(':memory:');
    const broken: Migration = {
      id: '9999_test_broken',
      owner: 'shared',
      up(d) {
        d.exec('CREATE TABLE half_done (x INTEGER)');
        throw new Error('boom');
      },
    };
    expect(() => migrate(db, [broken])).toThrow('boom');
    expect(tables(db)).not.toContain('half_done');
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
  });
});
