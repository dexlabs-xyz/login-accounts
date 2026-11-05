import { m0003 } from '../migrations/0003_oidc_initial.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterPayload } from 'oidc-provider';

export function createStorage(db: DatabaseSync) {
  m0003.up(db); // Idempotent for standalone protocol tests; shared server uses numbered migrations.
  const now = () => Math.floor(Date.now() / 1000);
  const find = (model: string, where: string, value: string): AdapterPayload | undefined => {
    const row = db.prepare(`SELECT payload FROM oidc_records WHERE model = ? AND ${where}
      AND (expires_at IS NULL OR expires_at > ?)`).get(model, value, now()) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  };
  return {
    adapter(model: string): Adapter {
      return {
        async upsert(id, payload, expiresIn) {
          db.prepare('DELETE FROM oidc_records WHERE expires_at <= ?').run(now());
          db.prepare(`INSERT INTO oidc_records VALUES (?, ?, ?, ?) ON CONFLICT(model, id)
            DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at`)
            .run(model, id, JSON.stringify(payload), expiresIn ? now() + expiresIn : null);
        },
        async find(id) { return find(model, 'id = ?', id); },
        async findByUid(uid) { return find(model, "json_extract(payload, '$.uid') = ?", uid); },
        async findByUserCode(code) { return find(model, "json_extract(payload, '$.userCode') = ?", code); },
        async consume(id) {
          db.prepare(`UPDATE oidc_records SET payload=json_set(payload, '$.consumed', ?)
            WHERE model=? AND id=?`).run(now(), model, id);
        },
        async destroy(id) { db.prepare('DELETE FROM oidc_records WHERE model=? AND id=?').run(model, id); },
        async revokeByGrantId(id) {
          db.prepare("DELETE FROM oidc_records WHERE json_extract(payload, '$.grantId') = ?").run(id);
        },
      };
    },
    subject(accountId: string, clientId: string): string {
      db.prepare('INSERT OR IGNORE INTO oidc_subjects VALUES (?, ?, ?)').run(accountId, clientId, randomUUID());
      return (db.prepare('SELECT subject FROM oidc_subjects WHERE account_id=? AND client_id=?')
        .get(accountId, clientId) as { subject: string }).subject;
    },
  };
}
