import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATION_V1, TARGET_VERSION } from './migrations.js';

export class GatewayDb {
  constructor(readonly raw: SqliteDatabase, private readonly persistent = false) {}

  prepare<P extends unknown[] | {} = unknown[], R = unknown>(sql: string): Statement<P, R> {
    return this.raw.prepare(sql) as Statement<P, R>;
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    return this.raw.transaction(fn) as unknown as T;
  }

  close(): void {
    if (!this.raw.open) return;
    try {
      if (this.persistent) this.raw.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      this.raw.close();
    }
  }
}

export function openGatewayDb(path: string): GatewayDb {
  const persistent = path !== ':memory:';
  if (persistent) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  if (persistent) {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL');
    sqlite.pragma('wal_autocheckpoint = 1');
  }
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  if (current < 1) sqlite.transaction(() => sqlite.exec(MIGRATION_V1))();
  sqlite.pragma(`user_version = ${TARGET_VERSION}`);
  return new GatewayDb(sqlite, persistent);
}
