import type { GatewayDb } from './db.js';
import type { ExtensionRecord } from './types.js';

interface ExtensionRow {
  id: string;
  version: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toExtensionRecord(row: ExtensionRow): ExtensionRecord {
  return {
    id: row.id,
    version: row.version,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ExtensionRepository {
  constructor(private readonly db: GatewayDb) {}

  upsert(id: string, version: string, enabled: boolean): ExtensionRecord {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('invalid_extension_id');
    if (typeof version !== 'string' || version.trim().length === 0) throw new Error('invalid_extension_version');
    if (typeof enabled !== 'boolean') throw new Error('invalid_extension_enabled');

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO extensions (id, version, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        version = excluded.version,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(id, version, enabled ? 1 : 0, now, now);

    return this.getRequired(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('invalid_extension_enabled');
    const result = this.db.prepare(`
      UPDATE extensions SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error('extension_not_found');
  }

  list(): ExtensionRecord[] {
    return this.db.prepare<[], ExtensionRow>(`
      SELECT id, version, enabled, created_at, updated_at
      FROM extensions
      ORDER BY created_at DESC, rowid DESC
    `).all().map(toExtensionRecord);
  }

  private getRequired(id: string): ExtensionRecord {
    const row = this.db.prepare<[string], ExtensionRow>(`
      SELECT id, version, enabled, created_at, updated_at
      FROM extensions WHERE id = ?
    `).get(id);
    if (!row) throw new Error('extension_not_found');
    return toExtensionRecord(row);
  }
}
