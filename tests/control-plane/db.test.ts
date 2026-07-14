import { afterEach, describe, expect, it } from 'vitest';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';

let db: GatewayDb | undefined;
afterEach(() => db?.close());

describe('GatewayDb', () => {
  it('creates every v1 control-plane table', () => {
    db = openGatewayDb(':memory:');
    const tables = db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'core_connection', 'extensions', 'invocation_targets', 'clients',
      'credentials', 'grants', 'runs', 'response_sessions',
      'idempotency_keys', 'admin_sessions',
    ]));
    expect(db.raw.pragma('user_version', { simple: true })).toBe(1);
  });

  it('enables foreign keys', () => {
    db = openGatewayDb(':memory:');
    expect(db.raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
