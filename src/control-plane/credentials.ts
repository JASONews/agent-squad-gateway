import { randomBytes, randomUUID } from 'node:crypto';
import type { GatewayDb } from './db.js';
import { constantTimeDigestMatch, decryptValue, digest, encryptValue } from '../security/crypto.js';
import type { AuthenticatedCredential, CreatedCredential } from './types.js';

const API_KEY = /^asqsk_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/;

interface CredentialRow {
  id: string;
  key_id: string;
  client_id: string;
  name: string;
  prefix: string;
  digest: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  rotated_from: string | null;
  client_status?: 'active' | 'disabled';
}

export interface CredentialRecord {
  id: string;
  clientId: string;
  name: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  rotatedFrom: string | null;
}

function toCredentialRecord(row: CredentialRow): CredentialRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    rotatedFrom: row.rotated_from,
  };
}

export class CredentialService {
  constructor(private readonly db: GatewayDb, private readonly masterKey: Buffer) {}

  create(clientId: string, name: string, expiresAt: string | null = null): CreatedCredential {
    return this.createCredential(clientId, name, null, expiresAt);
  }

  list(clientId?: string): CredentialRecord[] {
    const rows = clientId === undefined
      ? this.db.prepare<[], CredentialRow>(`
          SELECT id, client_id, name, prefix, created_at, expires_at, revoked_at, last_used_at, rotated_from
          FROM credentials
          ORDER BY created_at DESC, rowid DESC
        `).all()
      : this.db.prepare<[string], CredentialRow>(`
          SELECT id, client_id, name, prefix, created_at, expires_at, revoked_at, last_used_at, rotated_from
          FROM credentials
          WHERE client_id = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(clientId);

    return rows.map(toCredentialRecord);
  }

  authenticate(apiKey: string): AuthenticatedCredential | null {
    const parsed = API_KEY.exec(apiKey);
    if (!parsed) return null;

    const keyId = parsed[1];
    if (!keyId) return null;
    const credential = this.db.prepare<[string], CredentialRow>(`
      SELECT credentials.id, credentials.client_id, credentials.prefix, credentials.digest,
             credentials.expires_at, credentials.revoked_at, clients.status AS client_status
      FROM credentials
      JOIN clients ON clients.id = credentials.client_id
      WHERE credentials.key_id = ?
    `).get(keyId);
    if (!credential || !constantTimeDigestMatch(apiKey, credential.digest)) return null;

    const now = new Date().toISOString();
    if (credential.client_status !== 'active'
      || credential.revoked_at !== null
      || (credential.expires_at !== null && credential.expires_at <= now)) {
      return null;
    }

    const result = this.db.prepare(`
      UPDATE credentials
      SET last_used_at = ?
      WHERE id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
        AND EXISTS (SELECT 1 FROM clients WHERE id = credentials.client_id AND status = 'active')
    `).run(now, credential.id, now);
    if (result.changes !== 1) return null;

    return {
      credentialId: credential.id,
      clientId: credential.client_id,
      prefix: credential.prefix,
    };
  }

  reveal(id: string): string {
    const credential = this.db.prepare<[string], CredentialRow>(`
      SELECT ciphertext, nonce, auth_tag FROM credentials WHERE id = ?
    `).get(id);
    if (!credential) throw new Error('credential_not_found');

    return decryptValue({
      ciphertext: credential.ciphertext,
      nonce: credential.nonce,
      authTag: credential.auth_tag,
    }, this.masterKey);
  }

  revoke(id: string): void {
    const result = this.db.prepare(`
      UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), id);
    if (result.changes === 0) throw new Error('credential_not_found');
  }

  rotate(id: string, name: string, expiresAt: string | null = null): CreatedCredential {
    const createReplacement = this.db.transaction(() => {
      const original = this.db.prepare<[string], Pick<CredentialRow, 'client_id'>>(
        'SELECT client_id FROM credentials WHERE id = ? AND revoked_at IS NULL'
      ).get(id);
      if (!original) throw new Error('credential_not_found');

      const replacement = this.createCredential(original.client_id, name, id, expiresAt);
      const revoked = this.db.prepare(`
        UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      `).run(new Date().toISOString(), id);
      if (revoked.changes !== 1) throw new Error('credential_not_found');

      return replacement;
    });

    return createReplacement();
  }

  private createCredential(
    clientId: string,
    name: string,
    rotatedFrom: string | null,
    expiresAt: string | null,
  ): CreatedCredential {
    const keyId = randomBytes(9).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const apiKey = `asqsk_${keyId}_${secret}`;
    const envelope = encryptValue(apiKey, this.masterKey);
    const created: CreatedCredential = {
      id: `credential_${randomUUID()}`,
      clientId,
      prefix: `asqsk_${keyId}`,
      apiKey,
    };

    this.db.prepare(`
      INSERT INTO credentials (
        id, key_id, client_id, name, prefix, digest, ciphertext, nonce, auth_tag,
        created_at, expires_at, rotated_from
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      keyId,
      clientId,
      name,
      created.prefix,
      digest(apiKey),
      envelope.ciphertext,
      envelope.nonce,
      envelope.authTag,
      new Date().toISOString(),
      expiresAt,
      rotatedFrom,
    );

    return created;
  }
}
