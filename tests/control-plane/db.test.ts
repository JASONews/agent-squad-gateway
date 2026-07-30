import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { TargetRepository } from '../../src/control-plane/targets.js';

let db: GatewayDb | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  db?.close();
  db = undefined;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

  it('checkpoints clients, credentials, and targets into the persistent database', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-gateway-db-'));
    tempDirs.push(baseDir);
    const databasePath = join(baseDir, 'gateway.db');
    const snapshotPath = join(baseDir, 'gateway-snapshot.db');
    const masterKey = Buffer.alloc(32, 5);

    db = openGatewayDb(databasePath);
    expect(db.raw.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.raw.pragma('synchronous', { simple: true })).toBe(2);
    expect(db.raw.pragma('wal_autocheckpoint', { simple: true })).toBe(1);

    const client = new ClientRepository(db).create('persistent-client');
    const credential = new CredentialService(db, masterKey).create(client.id, 'primary');
    new TargetRepository(db).create({
      id: 'persistent-target',
      cli: 'codex',
      nativeModel: 'gpt-test',
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });

    await copyFile(databasePath, snapshotPath);
    const snapshot = openGatewayDb(snapshotPath);
    try {
      expect(new ClientRepository(snapshot).list()).toEqual([
        expect.objectContaining({ id: client.id, name: 'persistent-client' }),
      ]);
      expect(new CredentialService(snapshot, masterKey).reveal(credential.id)).toBe(credential.apiKey);
      expect(new TargetRepository(snapshot).list()).toEqual([
        expect.objectContaining({ id: 'persistent-target', nativeModel: 'gpt-test' }),
      ]);
    } finally {
      snapshot.close();
    }

    db.close();
    db = openGatewayDb(databasePath);
    expect(new ClientRepository(db).list()).toHaveLength(1);
    expect(new CredentialService(db, masterKey).reveal(credential.id)).toBe(credential.apiKey);
    expect(new TargetRepository(db).list()).toHaveLength(1);
  });
});
