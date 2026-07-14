import { randomUUID } from 'node:crypto';
import type { GatewayDb } from './db.js';
import type { ClientRecord, ClientStatus } from './types.js';

interface ClientRow {
  id: string;
  name: string;
  status: ClientStatus;
  created_at: string;
  updated_at: string;
}

function toClientRecord(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ClientRepository {
  constructor(private readonly db: GatewayDb) {}

  create(name: string): ClientRecord {
    const now = new Date().toISOString();
    const client: ClientRecord = {
      id: `client_${randomUUID()}`,
      name,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    try {
      this.db.prepare(`
        INSERT INTO clients (id, name, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(client.id, client.name, client.status, client.createdAt, client.updatedAt);
    } catch (error) {
      if (isUniqueNameError(error)) throw new Error('client_name_exists');
      throw error;
    }

    return client;
  }

  list(): ClientRecord[] {
    return this.db.prepare<[], ClientRow>(`
      SELECT id, name, status, created_at, updated_at
      FROM clients
      ORDER BY created_at DESC, rowid DESC
    `).all().map(toClientRecord);
  }

  setStatus(id: string, status: ClientStatus): void {
    const result = this.db.prepare(`
      UPDATE clients SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, new Date().toISOString(), id);

    if (result.changes === 0) throw new Error('client_not_found');
  }

  delete(id: string): void {
    const remove = this.db.transaction(() => {
      const client = this.db.prepare<[string], { id: string }>(
        'SELECT id FROM clients WHERE id = ?'
      ).get(id);
      if (!client) throw new Error('client_not_found');

      const active = this.db.prepare<[string], { count: number }>(`
        SELECT COUNT(*) AS count FROM runs
        WHERE client_id = ? AND status IN ('queued', 'running')
      `).get(id);
      if ((active?.count ?? 0) > 0) throw new Error('client_in_use');

      this.db.prepare('UPDATE runs SET client_id = NULL WHERE client_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM clients WHERE id = ?').run(id);
      if (result.changes !== 1) throw new Error('client_not_found');
    });
    remove();
  }
}

function isUniqueNameError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}
