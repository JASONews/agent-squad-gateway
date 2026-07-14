import { randomBytes } from 'node:crypto';
import type { GatewayDb } from '../control-plane/db.js';
import { constantTimeDigestMatch, digest } from './crypto.js';

export interface AdminLogin {
  cookie: string;
  csrfToken: string;
  expiresAt: string;
}

export interface AdminCsrf {
  csrfToken: string;
  expiresAt: string;
}

interface AdminAuthOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

interface AdminSessionRow {
  token_hash: string;
  csrf_hash: string;
  expires_at: string;
}

const BOOTSTRAP_BYTES = 24;
const BOOTSTRAP_TTL_MS = 60_000;
const SESSION_BYTES = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isCanonicalToken(value: string, bytes: number): boolean {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}

export class AdminAuthService {
  private readonly bootstrapCodes = new Map<string, number>();
  private readonly adminSecretDigest: string;
  private readonly now: () => number;
  private readonly generateRandomBytes: (size: number) => Buffer;

  constructor(
    private readonly db: GatewayDb,
    adminSecret: string | Buffer,
    options: AdminAuthOptions = {},
  ) {
    const canonicalSecret = Buffer.isBuffer(adminSecret)
      ? adminSecret.toString('base64url')
      : adminSecret;
    this.adminSecretDigest = digest(canonicalSecret);
    this.now = options.now ?? Date.now;
    this.generateRandomBytes = options.randomBytes ?? randomBytes;
  }

  mintBootstrapCode(adminSecret: string): string {
    this.purgeExpiredBootstrapCodes();
    if (!constantTimeDigestMatch(adminSecret, this.adminSecretDigest)) {
      throw new Error('admin_secret_invalid');
    }

    const code = this.generateRandomBytes(BOOTSTRAP_BYTES).toString('base64url');
    this.bootstrapCodes.set(code, this.now() + BOOTSTRAP_TTL_MS);
    return code;
  }

  exchange(code: string): AdminLogin {
    this.purgeExpiredBootstrapCodes();
    if (!isCanonicalToken(code, BOOTSTRAP_BYTES) || !this.bootstrapCodes.has(code)) {
      throw new Error('bootstrap_code_invalid');
    }

    this.bootstrapCodes.delete(code);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt + SESSION_TTL_MS).toISOString();
    const sessionToken = this.generateRandomBytes(SESSION_BYTES).toString('base64url');
    const csrfToken = this.generateRandomBytes(SESSION_BYTES).toString('base64url');

    this.db.prepare(`
      INSERT INTO admin_sessions (token_hash, csrf_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(digest(sessionToken), digest(csrfToken), expiresAt, new Date(createdAt).toISOString());

    return {
      cookie: `asq_gateway_admin=${sessionToken}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`,
      csrfToken,
      expiresAt,
    };
  }

  verifySession(sessionToken: string, csrfToken?: string): boolean {
    const row = this.findSession(sessionToken);
    if (!row) return false;

    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(row.token_hash);
      return false;
    }

    if (csrfToken === undefined) return true;
    return isCanonicalToken(csrfToken, SESSION_BYTES)
      && constantTimeDigestMatch(csrfToken, row.csrf_hash);
  }

  rotateCsrf(sessionToken: string, currentCsrfToken: string): AdminCsrf {
    if (!this.verifySession(sessionToken, currentCsrfToken)) throw new Error('admin_session_invalid');
    const row = this.findSession(sessionToken);
    if (!row) throw new Error('admin_session_invalid');

    const csrfToken = this.generateRandomBytes(SESSION_BYTES).toString('base64url');
    this.db.prepare(`
      UPDATE admin_sessions
      SET csrf_hash = ?
      WHERE token_hash = ?
    `).run(digest(csrfToken), row.token_hash);

    return { csrfToken, expiresAt: row.expires_at };
  }

  revokeSession(sessionToken: string): void {
    const row = this.findSession(sessionToken);
    if (row) this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(row.token_hash);
  }

  private findSession(sessionToken: string): AdminSessionRow | undefined {
    if (!isCanonicalToken(sessionToken, SESSION_BYTES)) return undefined;
    const row = this.db.prepare<[string], AdminSessionRow>(`
      SELECT token_hash, csrf_hash, expires_at
      FROM admin_sessions
      WHERE token_hash = ?
    `).get(digest(sessionToken));
    return row && constantTimeDigestMatch(sessionToken, row.token_hash) ? row : undefined;
  }

  private purgeExpiredBootstrapCodes(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.bootstrapCodes) {
      if (expiresAt <= now) this.bootstrapCodes.delete(code);
    }
  }
}
