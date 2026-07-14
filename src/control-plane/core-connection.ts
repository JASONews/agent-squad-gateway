import { parseCoreBaseUrl } from '../core-client/client.js';
import type { CoreHealth } from '../core-client/types.js';
import type { GatewayDb } from './db.js';

export type CoreConnectionStatus = 'unknown' | 'online' | 'degraded' | 'offline';

export interface CoreConnectionRecord {
  baseUrl: string;
  status: CoreConnectionStatus;
  version: string | null;
  lastCheckedAt: string | null;
}

interface CoreConnectionRow {
  base_url: string;
  last_status: string | null;
  last_version: string | null;
  last_checked_at: string | null;
}

export class CoreConnectionRepository {
  constructor(
    private readonly db: GatewayDb,
    private readonly now: () => Date | string = () => new Date(),
  ) {}

  get(): CoreConnectionRecord {
    const row = this.db.prepare<[], CoreConnectionRow>(`
      SELECT base_url, last_status, last_version, last_checked_at
      FROM core_connection WHERE singleton = 1
    `).get();
    if (!row) throw new Error('core_connection_missing');
    return {
      baseUrl: row.base_url,
      status: asStatus(row.last_status),
      version: row.last_version,
      lastCheckedAt: row.last_checked_at,
    };
  }

  update(baseUrl: string): CoreConnectionRecord {
    const normalized = parseCoreBaseUrl(baseUrl);
    const current = this.get();
    if (current.baseUrl === normalized) return current;
    this.db.prepare(`
      UPDATE core_connection
      SET base_url = ?, last_status = NULL, last_version = NULL, last_checked_at = NULL
      WHERE singleton = 1
    `).run(normalized);
    return this.get();
  }

  markHealth(health?: CoreHealth): CoreConnectionRecord {
    const status: CoreConnectionStatus = health === undefined
      ? 'offline'
      : health.ok && health.db_ok ? 'online' : 'degraded';
    const checkedAt = toIso(this.now());
    this.db.prepare(`
      UPDATE core_connection
      SET last_status = ?, last_version = COALESCE(?, last_version), last_checked_at = ?
      WHERE singleton = 1
    `).run(status, health?.version ?? null, checkedAt);
    return this.get();
  }
}

function asStatus(value: string | null): CoreConnectionStatus {
  return value === 'online' || value === 'degraded' || value === 'offline' ? value : 'unknown';
}

function toIso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}
