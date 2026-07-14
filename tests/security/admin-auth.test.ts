import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { requireAdmin } from '../../src/server/auth-hooks.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';

const ADMIN_SECRET = 'local-admin-secret';
const GATEWAY_ORIGIN = 'http://127.0.0.1:28772';
const VITE_ORIGIN = 'http://127.0.0.1:28773';

let now: number;
let randomCall: number;
let db: GatewayDb;
let auth: AdminAuthService;
let app: FastifyInstance | undefined;

function deterministicRandomBytes(size: number): Buffer {
  randomCall += 1;
  return Buffer.alloc(size, randomCall);
}

function sessionToken(cookie: string): string {
  const match = /^asq_gateway_admin=([^;]+);/.exec(cookie);
  if (!match) throw new Error('missing session token');
  return match[1];
}

beforeEach(() => {
  now = Date.parse('2026-07-10T12:00:00.000Z');
  randomCall = 0;
  db = openGatewayDb(':memory:');
  auth = new AdminAuthService(db, ADMIN_SECRET, {
    now: () => now,
    randomBytes: deterministicRandomBytes,
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  db.close();
});

describe('AdminAuthService', () => {
  it('mints a high-entropy bootstrap code only for the configured admin secret', () => {
    const code = auth.mintBootstrapCode(ADMIN_SECRET);

    expect(Buffer.from(code, 'base64url')).toHaveLength(24);
    expect(() => auth.mintBootstrapCode('wrong-secret')).toThrow('admin_secret_invalid');
  });

  it('exchanges a bootstrap code once and persists only session and CSRF digests', () => {
    const code = auth.mintBootstrapCode(ADMIN_SECRET);
    const login = auth.exchange(code);
    const token = sessionToken(login.cookie);

    expect(login.cookie).toBe(
      `asq_gateway_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`,
    );
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(Buffer.from(login.csrfToken, 'base64url')).toHaveLength(32);
    expect(login.expiresAt).toBe('2026-07-11T00:00:00.000Z');
    expect(() => auth.exchange(code)).toThrow('bootstrap_code_invalid');

    const row = db.prepare<[], {
      token_hash: string;
      csrf_hash: string;
      expires_at: string;
      created_at: string;
    }>('SELECT token_hash, csrf_hash, expires_at, created_at FROM admin_sessions').get();
    expect(row).toEqual({
      token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      csrf_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expires_at: login.expiresAt,
      created_at: '2026-07-10T12:00:00.000Z',
    });
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(login.csrfToken);
  });

  it('purges bootstrap codes after 60 seconds', () => {
    const code = auth.mintBootstrapCode(ADMIN_SECRET);
    now += 60_001;

    expect(() => auth.exchange(code)).toThrow('bootstrap_code_invalid');
  });

  it('verifies, expires, and revokes persisted sessions', () => {
    const login = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    const token = sessionToken(login.cookie);

    expect(auth.verifySession(token)).toBe(true);
    expect(auth.verifySession(token, login.csrfToken)).toBe(true);
    expect(auth.verifySession(token, 'wrong-csrf')).toBe(false);

    auth.revokeSession(token);
    expect(auth.verifySession(token)).toBe(false);

    const replacement = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    now += 12 * 60 * 60 * 1_000;
    expect(auth.verifySession(sessionToken(replacement.cookie))).toBe(false);
  });

  it('fails closed for malformed session and CSRF tokens', () => {
    const login = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    const token = sessionToken(login.cookie);

    expect(auth.verifySession(`${token}=`, login.csrfToken)).toBe(false);
    expect(auth.verifySession(token, `${login.csrfToken}=`)).toBe(false);
    expect(() => auth.revokeSession('not-base64url?')).not.toThrow();
  });
});

describe('requireAdmin', () => {
  beforeEach(async () => {
    app = Fastify({ logger: false });
    const guard = requireAdmin(auth, new Set([GATEWAY_ORIGIN, VITE_ORIGIN]));
    app.get('/admin/read', { preHandler: guard }, async () => ({ ok: true }));
    app.get('/admin/core/events', { preHandler: guard }, async () => ({ invalidated: true }));
    app.post('/admin/write', { preHandler: guard }, async () => ({ ok: true }));
    app.post(
      '/admin/no-auth-write',
      { preHandler: requireAdmin(auth, GATEWAY_ORIGIN, false) },
      async () => ({ ok: true }),
    );
    await app.ready();
  });

  it('requires CSRF on reads and exact trusted Origin plus CSRF on mutations', async () => {
    const login = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    const cookie = login.cookie.split(';', 1)[0];

    expect((await app!.inject({ method: 'GET', url: '/admin/read', headers: { cookie } })).statusCode)
      .toBe(403);
    expect((await app!.inject({
      method: 'GET', url: '/admin/read', headers: { cookie, 'x-csrf-token': login.csrfToken },
    })).statusCode).toBe(200);

    for (const origin of [GATEWAY_ORIGIN, VITE_ORIGIN]) {
      const valid = await app!.inject({
        method: 'POST',
        url: '/admin/write',
        headers: { cookie, origin, 'x-csrf-token': login.csrfToken },
      });
      expect(valid.statusCode, origin).toBe(200);
    }

    for (const headers of [
      { cookie, 'x-csrf-token': login.csrfToken },
      { cookie, origin: `${GATEWAY_ORIGIN}/`, 'x-csrf-token': login.csrfToken },
      { cookie, origin: 'http://127.0.0.1:9999', 'x-csrf-token': login.csrfToken },
      { cookie, origin: GATEWAY_ORIGIN },
      { cookie, origin: GATEWAY_ORIGIN, 'x-csrf-token': 'wrong-csrf' },
    ]) {
      const response = await app!.inject({ method: 'POST', url: '/admin/write', headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'csrf_invalid' } });
    }
  });

  it('allows admin requests without session or CSRF when the guard is disabled', async () => {
    const response = await app!.inject({ method: 'POST', url: '/admin/no-auth-write' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('allows the exact Core SSE route with only the cookie and returns invalidation metadata', async () => {
    const login = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    const cookie = login.cookie.split(';', 1)[0];

    const response = await app!.inject({ method: 'GET', url: '/admin/core/events', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ invalidated: true });
    expect(response.body).not.toMatch(/root_task|message|raw_tail|content/i);
  });

  it('returns a normalized 401 before CSRF checks when the exact session cookie is absent', async () => {
    const login = auth.exchange(auth.mintBootstrapCode(ADMIN_SECRET));
    const token = sessionToken(login.cookie);

    for (const cookie of [
      undefined,
      `asq_gateway_admin_extra=${token}`,
      `asq_gateway_admin=${token}; asq_gateway_admin=${token}`,
      `asq_gateway_admin=${token}=`,
    ]) {
      const response = await app!.inject({
        method: 'POST',
        url: '/admin/write',
        headers: cookie ? { cookie } : {},
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'admin_session_required', message: 'admin session required' },
      });
    }
  });
});
