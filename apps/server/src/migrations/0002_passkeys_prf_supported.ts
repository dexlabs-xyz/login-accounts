/**
 * 0002 — passkeys: what we know about each passkey's PRF support, so the UI
 * can say why a passkey can't open the wallet. NULL unknown, 0 no, 1 yes.
 */
import type { Migration } from './index.ts';

export const m0002: Migration = {
  id: '0002_passkeys_prf_supported',
  owner: 'passkeys',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(credentials)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'prf_supported')) return; // added before migrations existed
    db.exec('ALTER TABLE credentials ADD COLUMN prf_supported INTEGER');
    db.exec('UPDATE credentials SET prf_supported = 1 WHERE wrapped_key IS NOT NULL');
  },
};
