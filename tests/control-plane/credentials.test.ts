import { afterEach, describe, expect, it } from 'vitest';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { digest, encryptValue } from '../../src/security/crypto.js';

let db: GatewayDb | undefined;
afterEach(() => db?.close());

describe('CredentialService', () => {
  it('deletes clients atomically with credentials and grants while preserving completed runs', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('delete-client');
    const credentials = new CredentialService(db, Buffer.alloc(32, 5));
    const extensions = new ExtensionRepository(db);
    const targets = new TargetRepository(db);
    const grants = new GrantRepository(db);
    const primary = credentials.create(client.id, 'primary');
    credentials.rotate(primary.id, 'replacement');
    extensions.upsert('openai', '1.0.0', true);
    const target = targets.create({
      id: 'delete-target', cli: 'codex', nativeModel: 'gpt-5', isolationLevel: 'strict',
      streamingMode: 'native', toolBridge: 'structured_output', maxConcurrency: 1,
      maxQueue: 8, queueTimeoutMs: 300_000, runTimeoutMs: null,
    });
    grants.grant(client.id, 'openai', target.id);
    db.prepare(`
      INSERT INTO runs (id, client_id, extension_id, target_id, endpoint, status, queued_at)
      VALUES ('active-run', ?, 'openai', ?, '/v1/responses', 'running', ?)
    `).run(client.id, target.id, new Date().toISOString());

    expect(() => clients.delete(client.id)).toThrow('client_in_use');
    expect(credentials.list(client.id)).toHaveLength(2);
    expect(grants.listForClient(client.id)).toHaveLength(1);

    db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'active-run'").run();
    clients.delete(client.id);
    expect(clients.list()).toHaveLength(0);
    expect(credentials.list(client.id)).toHaveLength(0);
    expect(grants.listForClient(client.id)).toHaveLength(0);
    expect(db.prepare<[], { client_id: string | null }>(
      "SELECT client_id FROM runs WHERE id = 'active-run'"
    ).get()?.client_id).toBeNull();
    expect(() => clients.delete(client.id)).toThrow('client_not_found');
  });

  it('creates, authenticates, reveals, revokes, and rotates credentials', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('local-litellm');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const created = service.create(client.id, 'primary');
    const untouched = service.create(client.id, 'untouched');
    expect(created.apiKey).toMatch(/^asqsk_[a-f0-9]{18}_[A-Za-z0-9_-]{43}$/);
    expect(service.authenticate(created.apiKey)?.clientId).toBe(client.id);
    expect(service.reveal(created.id)).toBe(created.apiKey);
    const rotated = service.rotate(created.id, 'rotated');
    expect(service.authenticate(created.apiKey)).toBeNull();
    expect(service.authenticate(rotated.apiKey)?.credentialId).toBe(rotated.id);
    expect(service.authenticate(untouched.apiKey)?.credentialId).toBe(untouched.id);
    expect(service.reveal(rotated.id)).toBe(rotated.apiKey);
    service.revoke(rotated.id);
    expect(service.authenticate(rotated.apiKey)).toBeNull();
  });

  it('rejects malformed API keys', () => {
    db = openGatewayDb(':memory:');
    const service = new CredentialService(db, Buffer.alloc(32, 5));

    expect(service.authenticate('asqsk_not-hex_secret')).toBeNull();
    expect(service.authenticate('asqsk_0123456789abcdef01_short')).toBeNull();
    expect(service.authenticate('asqsk_0123456789abcdef01_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });

  it('authenticates a valid key whose base64url secret contains underscores', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('underscore-client');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const created = service.create(client.id, 'primary');
    const keyId = /^asqsk_([a-f0-9]{18})_/.exec(created.apiKey)?.[1];
    const apiKey = `asqsk_${keyId}_${'_'.repeat(43)}`;
    const envelope = encryptValue(apiKey, Buffer.alloc(32, 5));

    db.prepare(`
      UPDATE credentials
      SET digest = ?, ciphertext = ?, nonce = ?, auth_tag = ?
      WHERE id = ?
    `).run(digest(apiKey), envelope.ciphertext, envelope.nonce, envelope.authTag, created.id);

    expect(service.authenticate(apiKey)).toEqual({
      credentialId: created.id,
      clientId: client.id,
      prefix: created.prefix,
    });
  });

  it('rejects malformed persisted digests without updating last use', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('malformed-digest-client');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const created = service.create(client.id, 'primary');
    const originalDigest = digest(created.apiKey);

    db.prepare('UPDATE credentials SET digest = ? WHERE id = ?')
      .run(`${originalDigest}zz`, created.id);
    expect(service.authenticate(created.apiKey)).toBeNull();
    expect(db.prepare<[string], { last_used_at: string | null }>(
      'SELECT last_used_at FROM credentials WHERE id = ?'
    ).get(created.id)?.last_used_at).toBeNull();

    db.prepare('UPDATE credentials SET digest = ? WHERE id = ?')
      .run(originalDigest.toUpperCase(), created.id);
    expect(service.authenticate(created.apiKey)).toBeNull();
    expect(db.prepare<[string], { last_used_at: string | null }>(
      'SELECT last_used_at FROM credentials WHERE id = ?'
    ).get(created.id)?.last_used_at).toBeNull();
  });

  it('creates and lists clients, rejects duplicate names, and reports missing clients', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const first = clients.create('first');
    const second = clients.create('second');

    expect(first.id).toMatch(/^client_[0-9a-f-]{36}$/);
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(clients.list().map((client) => client.id)).toEqual([second.id, first.id]);
    expect(() => clients.create('first')).toThrow('client_name_exists');
    expect(() => clients.setStatus('client_missing', 'disabled')).toThrow('client_not_found');
  });

  it('rejects credentials for disabled clients and expired or revoked credentials', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('stateful-client');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const active = service.create(client.id, 'active');

    clients.setStatus(client.id, 'disabled');
    expect(service.authenticate(active.apiKey)).toBeNull();

    clients.setStatus(client.id, 'active');
    db.prepare('UPDATE credentials SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), active.id);
    expect(service.authenticate(active.apiKey)).toBeNull();

    const revoked = service.create(client.id, 'revoked');
    service.revoke(revoked.id);
    expect(service.authenticate(revoked.apiKey)).toBeNull();
  });

  it('does not expose plaintext values from credential listings and updates last use', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('listed-client');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const created = service.create(client.id, 'primary');

    expect(service.list(client.id)).toEqual([expect.objectContaining({
      id: created.id,
      clientId: client.id,
      name: 'primary',
      prefix: created.prefix,
    })]);
    expect(service.list(client.id)[0]).not.toHaveProperty('apiKey');
    expect(service.list(client.id)[0]).not.toHaveProperty('ciphertext');
    expect(service.authenticate(created.apiKey)?.credentialId).toBe(created.id);
    expect(db.prepare<[string], { last_used_at: string }>(
      'SELECT last_used_at FROM credentials WHERE id = ?'
    ).get(created.id)?.last_used_at).toEqual(expect.any(String));
  });

  it('rolls back a rotation when revoking its predecessor fails', () => {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const client = clients.create('atomic-client');
    const service = new CredentialService(db, Buffer.alloc(32, 5));
    const created = service.create(client.id, 'primary');
    const untouched = service.create(client.id, 'untouched');
    db.raw.exec(`
      CREATE TRIGGER reject_rotation
      BEFORE UPDATE OF revoked_at ON credentials
      WHEN OLD.id = '${created.id}'
      BEGIN
        SELECT RAISE(ABORT, 'rotation rejected');
      END;
    `);

    expect(() => service.rotate(created.id, 'rotated')).toThrow('rotation rejected');
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM credentials').get()?.count).toBe(2);
    expect(service.authenticate(created.apiKey)?.credentialId).toBe(created.id);
    expect(service.authenticate(untouched.apiKey)?.credentialId).toBe(untouched.id);
  });
});
