import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { registerAdminRoutes } from '../../src/server/admin-routes.js';
import { registerUiRoutes } from '../../src/server/ui-routes.js';

describe('Gateway production UI routes', () => {
  let app: FastifyInstance;
  let uiRoot: string;

  beforeEach(async () => {
    uiRoot = mkdtempSync(join(tmpdir(), 'asq-gateway-ui-'));
    mkdirSync(join(uiRoot, 'assets'));
    writeFileSync(join(uiRoot, 'index.html'), '<!doctype html><title>Gateway UI fixture</title>');
    writeFileSync(join(uiRoot, 'assets', 'index-AbCd1234.js'), 'window.gatewayFixture = true;');
    writeFileSync(join(uiRoot, 'assets', 'manifest.json'), '{}');

    app = Fastify({ logger: false });
    registerUiRoutes(app, { root: uiRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(uiRoot, { recursive: true, force: true });
  });

  it('serves index.html for root and owned deep links without caching it', async () => {
    for (const url of ['/', '/overview', '/operations/runs']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html,application/xhtml+xml' },
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.body).toContain('Gateway UI fixture');
    }
  });

  it('serves only hashed assets with immutable caching', async () => {
    const hashed = await app.inject({ method: 'GET', url: '/assets/index-AbCd1234.js' });
    expect(hashed.statusCode).toBe(200);
    expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const unhashed = await app.inject({ method: 'GET', url: '/assets/manifest.json' });
    expect(unhashed.statusCode).toBe(200);
    expect(unhashed.headers['cache-control']).toBe('no-cache');
  });

  it('never swallows API namespaces, unknown API requests, SSE, or non-GET methods', async () => {
    const requests = [
      { method: 'GET' as const, url: '/admin/missing', accept: 'text/html' },
      { method: 'GET' as const, url: '/v1/missing', accept: 'text/html' },
      { method: 'GET' as const, url: '/health/details', accept: 'text/html' },
      { method: 'GET' as const, url: '/unknown-api', accept: 'application/json' },
      {
        method: 'GET' as const,
        url: '/unknown-api-with-html-disabled',
        accept: 'application/json, text/html;q=0',
      },
      { method: 'GET' as const, url: '/unknown-events', accept: 'text/event-stream' },
      {
        method: 'GET' as const,
        url: '/unknown-events-with-html-disabled',
        accept: 'text/event-stream, text/html;q=0',
      },
      { method: 'POST' as const, url: '/overview', accept: 'text/html' },
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { accept: request.accept },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
      expect(response.body).not.toContain('Gateway UI fixture');
    }
  });
});

describe('Gateway browser session recovery routes', () => {
  const gatewayOrigin = 'http://127.0.0.1:28772';
  let app: FastifyInstance;
  let auth: AdminAuthService;
  let db: GatewayDb;

  beforeEach(async () => {
    db = openGatewayDb(':memory:');
    auth = new AdminAuthService(db, 'admin-secret');
    app = Fastify({ logger: false });
    registerAdminRoutes(app, {
      config: resolveGatewayConfig({ webUiAuth: 'token' }),
      clients: new ClientRepository(db),
      credentials: new CredentialService(db, Buffer.alloc(32, 1)),
      targets: new TargetRepository(db),
      grants: new GrantRepository(db),
      extensions: new ExtensionRepository(db),
      runs: new RunRepository(db),
      adminAuth: auth,
      trustedOrigins: new Set([gatewayOrigin]),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('rotates CSRF using a valid cookie, current CSRF, and exact Origin', async () => {
    const login = auth.exchange(auth.mintBootstrapCode('admin-secret'));
    const cookie = login.cookie.split(';', 1)[0]!;

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/admin/session/csrf',
      headers: {
        cookie,
        origin: 'http://attacker.invalid',
        'x-csrf-token': login.csrfToken,
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const response = await app.inject({
      method: 'POST',
      url: '/admin/session/csrf',
      headers: {
        cookie,
        origin: gatewayOrigin,
        'x-csrf-token': login.csrfToken,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      csrf_token: expect.any(String),
      expires_at: login.expiresAt,
    });
    const rotated = response.json<{ csrf_token: string }>().csrf_token;
    const token = cookie.slice('asq_gateway_admin='.length);
    expect(auth.verifySession(token, login.csrfToken)).toBe(false);
    expect(auth.verifySession(token, rotated)).toBe(true);
  });

  it('revokes the session and clears the cookie on logout', async () => {
    const login = auth.exchange(auth.mintBootstrapCode('admin-secret'));
    const cookie = login.cookie.split(';', 1)[0]!;

    const response = await app.inject({
      method: 'POST',
      url: '/admin/session/logout',
      headers: {
        cookie,
        origin: gatewayOrigin,
        'x-csrf-token': login.csrfToken,
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBe(
      'asq_gateway_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0',
    );

    const refresh = await app.inject({
      method: 'POST',
      url: '/admin/session/csrf',
      headers: { cookie, origin: gatewayOrigin },
    });
    expect(refresh.statusCode).toBe(401);
  });
});
