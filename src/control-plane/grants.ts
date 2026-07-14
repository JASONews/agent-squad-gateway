import type { GatewayDb } from './db.js';
import type { GrantRecord, InvocationTarget } from './types.js';
import {
  hasCurrentCompatibleCapability,
  toInvocationTarget,
  type InvocationTargetRow,
} from './targets.js';

interface GrantRow {
  client_id: string;
  extension_id: string;
  target_id: string;
  created_at: string;
}

interface AuthorizedTargetRow extends InvocationTargetRow {
  client_status: 'active' | 'disabled';
  extension_enabled: number;
}

function toGrantRecord(row: GrantRow): GrantRecord {
  return {
    clientId: row.client_id,
    extensionId: row.extension_id,
    targetId: row.target_id,
    createdAt: row.created_at,
  };
}

export class GrantRepository {
  constructor(private readonly db: GatewayDb) {}

  grant(clientId: string, extensionId: string, targetId: string): void {
    const target = this.findTarget(targetId);
    if (!target) throw new Error('target_not_found');
    this.requireClient(clientId);
    this.requireExtension(extensionId);
    this.db.prepare(`
      INSERT INTO grants (client_id, extension_id, target_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(client_id, extension_id, target_id) DO NOTHING
    `).run(clientId, extensionId, target.id, new Date().toISOString());
  }

  revoke(clientId: string, extensionId: string, targetId: string): void {
    const target = this.findTarget(targetId);
    if (!target) throw new Error('target_not_found');
    this.db.prepare(`
      DELETE FROM grants WHERE client_id = ? AND extension_id = ? AND target_id = ?
    `).run(clientId, extensionId, target.id);
  }

  listForClient(clientId: string): GrantRecord[] {
    return this.db.prepare<[string], GrantRow>(`
      SELECT client_id, extension_id, target_id, created_at
      FROM grants
      WHERE client_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(clientId).map(toGrantRecord);
  }

  authorize(clientId: string, extensionId: string, modelId: string): InvocationTarget {
    const row = this.db.prepare<[string, string, string, string], AuthorizedTargetRow>(`
      SELECT
        t.id, t.aliases_json, t.cli, t.native_model, t.reasoning_effort, t.enabled,
        t.isolation_level, t.streaming_mode, t.tool_bridge, t.max_concurrency, t.max_queue,
        t.queue_timeout_ms, t.run_timeout_ms, t.fixed_workspace, t.capability_version,
        t.capability_verified_at, t.capability_json, t.capability_error, t.created_at, t.updated_at,
        c.status AS client_status, e.enabled AS extension_enabled
      FROM grants AS g
      JOIN clients AS c ON c.id = g.client_id
      JOIN extensions AS e ON e.id = g.extension_id
      JOIN invocation_targets AS t ON t.id = g.target_id
      WHERE g.client_id = ?
        AND g.extension_id = ?
        AND (
          t.id = ?
          OR EXISTS (
            SELECT 1
            FROM json_each(CASE WHEN json_valid(t.aliases_json) THEN t.aliases_json ELSE '[]' END)
            WHERE value = ?
          )
        )
      LIMIT 1
    `).get(clientId, extensionId, modelId, modelId);

    if (!row) throw new Error('authorization_denied');
    const target = toInvocationTarget(row);
    if (row.client_status !== 'active'
      || row.extension_enabled !== 1
      || !target.enabled
      || !hasCurrentCompatibleCapability(target)) {
      throw new Error('authorization_denied');
    }
    return target;
  }

  private findTarget(idOrAlias: string): InvocationTarget | null {
    const row = this.db.prepare<[string, string], InvocationTargetRow>(`
      SELECT
        id, aliases_json, cli, native_model, reasoning_effort, enabled,
        isolation_level, streaming_mode, tool_bridge, max_concurrency, max_queue,
        queue_timeout_ms, run_timeout_ms, fixed_workspace, capability_version,
        capability_verified_at, capability_json, capability_error, created_at, updated_at
      FROM invocation_targets
      WHERE id = ?
         OR EXISTS (
           SELECT 1
           FROM json_each(CASE WHEN json_valid(aliases_json) THEN aliases_json ELSE '[]' END)
           WHERE value = ?
         )
      LIMIT 1
    `).get(idOrAlias, idOrAlias);
    return row ? toInvocationTarget(row) : null;
  }

  private requireClient(id: string): void {
    const row = this.db.prepare<[string], { id: string }>('SELECT id FROM clients WHERE id = ?').get(id);
    if (!row) throw new Error('client_not_found');
  }

  private requireExtension(id: string): void {
    const row = this.db.prepare<[string], { id: string }>('SELECT id FROM extensions WHERE id = ?').get(id);
    if (!row) throw new Error('extension_not_found');
  }
}
