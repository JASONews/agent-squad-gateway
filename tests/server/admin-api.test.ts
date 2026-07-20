import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { CoreClient } from '../../src/core-client/client.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { CapabilityService } from '../../src/provider-runtime/capability-service.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { ensureSecretFile } from '../../src/security/secret-files.js';
import { buildGatewayApp, type GatewayAppDependencies } from '../../src/server/app.js';
import { AGENT_SQUAD_GATEWAY_VERSION } from '../../src/version.js';

const ADMIN_SECRET_BYTES = Buffer.from('local-admin-secret');
const ADMIN_SECRET = ADMIN_SECRET_BYTES.toString('base64url');
const GATEWAY_ORIGIN = 'http://127.0.0.1:28772';
const VITE_ORIGIN = 'http://127.0.0.1:28773';
const ATTACKER_ORIGIN = 'http://attacker.invalid:28772';

let app: FastifyInstance;
let db: GatewayDb;
let dirs: string[];
let dependencies: GatewayAppDependencies;
let clients: ClientRepository;
let credentials: CredentialService;
let targets: TargetRepository;
let extensions: ExtensionRepository;
let capabilityScanCount: number;
let capabilityVerifyCount: number;
let capabilityFailure: Error | null;
let staticCapabilityVersion: string;

function json(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

function sessionHeaders(cookie: string, csrfToken: string): Record<string, string> {
  return {
    cookie: cookie.split(';', 1)[0]!,
    origin: GATEWAY_ORIGIN,
    'x-csrf-token': csrfToken,
  };
}

function targetPayload(id: string): Record<string, unknown> {
  return {
    id,
    aliases: ['codex/gpt-5.6/max'],
    cli: 'codex',
    native_model: 'gpt-5.6',
    reasoning_effort: 'max',
    isolation_level: 'best_effort',
    streaming_mode: 'native',
    tool_bridge: 'structured_output',
    max_concurrency: 1,
    max_queue: 8,
    queue_timeout_ms: 300000,
    run_timeout_ms: null,
  };
}

async function createSessionHeaders(): Promise<Record<string, string>> {
  const mint = await app.inject({
    method: 'POST', url: '/admin/bootstrap/mint', headers: { authorization: `Bearer ${ADMIN_SECRET}` },
  });
  const exchange = await app.inject({
    method: 'POST', url: '/admin/bootstrap/exchange', payload: { code: json(mint).code },
  });
  return sessionHeaders(exchange.headers['set-cookie']!, json(exchange).csrf_token as string);
}

beforeEach(async () => {
  dirs = [];
  const baseDir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-admin-api-'));
  dirs.push(baseDir);
  const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
  const masterKey = ensureSecretFile(config.paths.masterKeyPath, 32);
  fs.writeFileSync(config.paths.adminSecretPath, ADMIN_SECRET_BYTES, { mode: 0o600 });
  db = openGatewayDb(':memory:');
  clients = new ClientRepository(db);
  credentials = new CredentialService(db, masterKey);
  targets = new TargetRepository(db);
  extensions = new ExtensionRepository(db);
  const grants = new GrantRepository(db);
  const runs = new RunRepository(db);
  const adminAuth = new AdminAuthService(db, fs.readFileSync(config.paths.adminSecretPath));
  capabilityScanCount = 0;
  capabilityVerifyCount = 0;
  capabilityFailure = null;
  staticCapabilityVersion = '1.2.0';
  const staticCapabilities = {
    available: true, verified: false, modelSelection: true,
    effortSelection: true, isolationLevel: 'strict' as const, streamingMode: 'native' as const,
    toolBridge: 'structured_output' as const, resume: true, cancellation: true,
  };
  const capabilityService = {
    listAvailability: () => [{
      cli: 'codex', scannedAt: '2026-07-12T12:30:00.000Z',
      capabilities: { ...staticCapabilities, version: staticCapabilityVersion },
    }],
    scanInstalled: async () => { capabilityScanCount += 1; return []; },
    verifyTarget: async (id: string) => {
      capabilityVerifyCount += 1;
      if (capabilityFailure) throw capabilityFailure;
      targets.setCapability(id, {
        version: '1.2.0', verifiedAt: '2026-07-12T12:31:00.000Z',
        capabilities: {
          isolationLevel: 'strict', streamingMode: 'native', toolBridge: 'structured_output',
          resume: true, cancellation: true, modelSelection: true, effortSelection: true,
        },
      });
      return { ...staticCapabilities, version: '1.2.0', verified: true, verifiedAt: '2026-07-12T12:31:00.000Z' };
    },
  } as unknown as CapabilityService;
  dependencies = {
    config,
    db,
    clients,
    credentials,
    targets,
    grants,
    extensions,
    runs,
    adminAuth,
    capabilityService,
  };
  app = buildGatewayApp(dependencies);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe('Gateway control-plane admin API', () => {
  it('exposes the auth mode publicly and allows default disabled-mode admin access', async () => {
    expect(json(await app.inject({ method: 'GET', url: '/admin/auth/mode' })))
      .toEqual({ mode: 'token' });

    await app.close();
    dependencies = {
      ...dependencies,
      config: resolveGatewayConfig({ baseDir: dirs[0]! }),
    };
    app = buildGatewayApp(dependencies);
    await app.ready();

    expect(json(await app.inject({ method: 'GET', url: '/admin/auth/mode' })))
      .toEqual({ mode: 'disabled' });
    expect((await app.inject({ method: 'GET', url: '/admin/settings' })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST',
      url: '/admin/clients',
      payload: { name: 'No-login local client' },
    })).statusCode).toBe(201);
  });

  it('returns authenticated settings definitions without secret file contents', async () => {
    const headers = await createSessionHeaders();

    const response = await app.inject({ method: 'GET', url: '/admin/settings', headers });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json(response)).toEqual({
      core: {
        base_url: 'http://127.0.0.1:28771',
        status: 'unknown',
        version: null,
        last_checked_at: null,
      },
      bind_address: '0.0.0.0:28772',
      state_paths: {
        config: dependencies.config.paths.configPath,
        database: dependencies.config.paths.dbPath,
        master_key: dependencies.config.paths.masterKeyPath,
        admin_secret: dependencies.config.paths.adminSecretPath,
      },
      retention: { metadata_days: 30, replay_ttl_minutes: 10 },
      security: { bind: 'all-interfaces', cors: 'disabled', web_ui_auth: 'token' },
    });
    expect(response.body).not.toContain(ADMIN_SECRET);
    expect(response.body).not.toContain(ADMIN_SECRET_BYTES.toString());
  });

  it('hydrates persisted Core settings into a fresh app and client without mutating them on read', async () => {
    const headers = await createSessionHeaders();
    const savedUrl = 'http://localhost:29999';
    expect((await app.inject({
      method: 'PATCH', url: '/admin/settings/core', headers, payload: { base_url: savedUrl },
    })).statusCode).toBe(200);

    await app.close();
    const restartedConfig = resolveGatewayConfig({ baseDir: dirs[0]!, webUiAuth: 'token' });
    const requestedUrls: string[] = [];
    const restartedCoreClient = new CoreClient(restartedConfig.coreUrl, {
      fetch: async (input) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify({ ok: true, version: '0.1.0', db_ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    dependencies = { ...dependencies, config: restartedConfig, coreClient: restartedCoreClient };
    app = buildGatewayApp(dependencies);
    await app.ready();

    expect(restartedConfig.coreUrl).toBe(savedUrl);
    expect(json(await app.inject({ method: 'GET', url: '/admin/settings', headers }))).toMatchObject({
      core: { base_url: savedUrl },
    });
    await restartedCoreClient.health();
    expect(requestedUrls).toEqual([`${savedUrl}/v1/health`]);
  });

  it('rolls back atomic setup client/key creation and retries after app reload', async () => {
    const headers = await createSessionHeaders();
    const createCredential = credentials.create.bind(credentials);
    let failCredentialCreation = true;
    credentials.create = (...args) => {
      if (failCredentialCreation) {
        failCredentialCreation = false;
        throw new Error('injected_setup_credential_failure');
      }
      return createCredential(...args);
    };

    const failed = await app.inject({
      method: 'POST', url: '/admin/setup/client-credential', headers,
      payload: { name: 'Atomic setup client' },
    });
    expect(failed.statusCode).toBe(500);
    expect(clients.list()).toEqual([]);
    expect(credentials.list()).toEqual([]);

    await app.close();
    app = buildGatewayApp(dependencies);
    await app.ready();
    expect(json(await app.inject({ method: 'GET', url: '/admin/setup/status', headers }))).toMatchObject({
      client_count: 0,
      credential_count: 0,
    });

    const retried = await app.inject({
      method: 'POST', url: '/admin/setup/client-credential', headers,
      payload: { name: 'Atomic setup client' },
    });
    expect(retried.statusCode).toBe(201);
    expect(retried.headers['cache-control']).toBe('no-store');
    expect(json(retried)).toMatchObject({ api_key: expect.stringMatching(/^asqsk_/) });
    expect(clients.list()).toHaveLength(1);
    expect(credentials.list()).toHaveLength(1);
    expect(dependencies.grants.listForClient(clients.list()[0]!.id)).toEqual([]);
    expect(targets.list()).toEqual([]);
    expect(capabilityVerifyCount).toBe(0);
  });

  it('updates only loopback Core URLs and derives setup progress from Gateway resources', async () => {
    const headers = await createSessionHeaders();
    const rejected = await app.inject({
      method: 'PATCH', url: '/admin/settings/core', headers,
      payload: { base_url: 'https://example.com' },
    });
    expect(rejected.statusCode).toBe(400);
    expect(json(rejected)).toMatchObject({ error: { code: 'invalid_core_url' } });

    const updated = await app.inject({
      method: 'PATCH', url: '/admin/settings/core', headers,
      payload: { base_url: 'http://localhost:29999/' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers['cache-control']).toBe('no-store');
    expect(json(updated)).toEqual({ base_url: 'http://localhost:29999' });

    await app.inject({ method: 'GET', url: '/admin/core/health', headers });
    const client = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Setup client' },
    });
    const clientId = json(client).id as string;
    const credential = await app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/credentials`, headers,
      payload: { name: 'Setup client', expires_at: null },
    });
    await app.inject({
      method: 'POST', url: '/admin/targets', headers, payload: targetPayload('setup-target'),
    });
    expect(targets.get('setup-target')).toMatchObject({
      enabled: false,
      capabilityVerifiedAt: null,
      capabilities: null,
    });
    expect(dependencies.grants.listForClient(clientId)).toEqual([]);
    expect(capabilityVerifyCount).toBe(0);

    const status = await app.inject({ method: 'GET', url: '/admin/setup/status', headers });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(json(status)).toEqual({
      core_configured: true,
      cli_scan_complete: true,
      target_count: 1,
      client_count: 1,
      credential_count: 1,
    });
    expect(status.body).not.toContain(json(credential).api_key as string);
  });

  it('administers client metadata, expiring credentials, rotation, revocation, and grants', async () => {
    const headers = await createSessionHeaders();
    extensions.upsert('openai', '1.0.0', true);
    const clientResponse = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Task 5 client' },
    });
    const clientId = json(clientResponse).id as string;
    const expiresAt = '2030-01-02T03:04:05.000Z';
    const created = await app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/credentials`, headers,
      payload: { name: 'primary', expires_at: expiresAt },
    });
    const oldCredential = json(created);
    expect(oldCredential.api_key).toMatch(/^asqsk_/);
    const secondaryResponse = await app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/credentials`, headers,
      payload: { name: 'secondary', expires_at: null },
    });
    const secondaryCredential = json(secondaryResponse);

    const targetResponse = await app.inject({
      method: 'POST', url: '/admin/targets', headers, payload: targetPayload('task5-target'),
    });
    expect(targetResponse.statusCode).toBe(201);
    await app.inject({
      method: 'POST', url: '/admin/grants', headers,
      payload: { client_id: clientId, extension_id: 'openai', target_id: 'task5-target' },
    });

    const listed = await app.inject({ method: 'GET', url: '/admin/clients', headers });
    expect(json(listed)).toEqual({ clients: [expect.objectContaining({
      id: clientId, credentialCount: 2, grantCount: 1, lastUsedAt: null,
    })] });
    expect(listed.body).not.toContain(oldCredential.api_key as string);

    const detail = await app.inject({ method: 'GET', url: `/admin/clients/${clientId}`, headers });
    expect(json(detail)).toMatchObject({
      client: { id: clientId, status: 'active' },
      credentials: expect.arrayContaining([
        expect.objectContaining({ id: oldCredential.id, expiresAt }),
        expect.objectContaining({ id: secondaryCredential.id, revokedAt: null }),
      ]),
      grants: [{ extensionId: 'openai', targetId: 'task5-target' }],
    });
    expect(detail.body).not.toContain(oldCredential.api_key as string);

    const rotated = await app.inject({
      method: 'POST', url: `/admin/credentials/${oldCredential.id as string}/rotate`, headers,
      payload: { name: 'replacement', expires_at: null },
    });
    expect(rotated.statusCode).toBe(201);
    expect(rotated.headers['cache-control']).toBe('no-store');
    expect(json(rotated).api_key).toMatch(/^asqsk_/);
    expect(json(rotated).api_key).not.toBe(oldCredential.api_key);
    expect((await app.inject({
      method: 'GET', url: `/admin/clients/${clientId}`, headers,
    })).json()).toMatchObject({ credentials: expect.arrayContaining([
      expect.objectContaining({ id: oldCredential.id, revokedAt: expect.any(String) }),
      expect.objectContaining({ rotatedFrom: oldCredential.id }),
      expect.objectContaining({ id: secondaryCredential.id, revokedAt: null }),
    ]) });

    const replacementId = json(rotated).id as string;
    expect((await app.inject({
      method: 'POST', url: `/admin/credentials/${replacementId}/revoke`, headers, payload: {},
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: 'DELETE', url: '/admin/grants', headers,
      payload: { client_id: clientId, extension_id: 'openai', target_id: 'task5-target' },
    })).statusCode).toBe(204);
    expect((await app.inject({
      method: 'GET', url: `/admin/clients/${clientId}`, headers,
    })).json()).toMatchObject({ grants: [] });
    expect((await app.inject({
      method: 'PATCH', url: `/admin/clients/${clientId}`, headers, payload: { status: 'disabled' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: `/admin/clients/${clientId}`, headers,
    })).json()).toMatchObject({ client: { status: 'disabled' } });
  });

  it('deletes clients with cascades, preserves completed runs, and reports conflicts and missing clients', async () => {
    const headers = await createSessionHeaders();
    extensions.upsert('openai', '1.0.0', true);
    const clientResponse = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Delete client' },
    });
    const clientId = json(clientResponse).id as string;
    const credential = await app.inject({
      method: 'POST', url: `/admin/clients/${clientId}/credentials`, headers,
      payload: { name: 'delete-key' },
    });
    const target = targets.create({
      id: 'delete-client-target', cli: 'codex', nativeModel: 'gpt-5', isolationLevel: 'strict',
      streamingMode: 'native', toolBridge: 'structured_output', maxConcurrency: 1,
      maxQueue: 8, queueTimeoutMs: 300_000, runTimeoutMs: null,
    });
    dependencies.grants.grant(clientId, 'openai', target.id);
    db.prepare(`
      INSERT INTO runs (id, client_id, extension_id, target_id, endpoint, status, queued_at)
      VALUES ('client-delete-run', ?, 'openai', ?, '/v1/models', 'queued', ?)
    `).run(clientId, target.id, new Date().toISOString());

    const conflict = await app.inject({ method: 'DELETE', url: `/admin/clients/${clientId}`, headers });
    expect(conflict.statusCode).toBe(409);
    expect(json(conflict)).toMatchObject({ error: { code: 'client_in_use' } });

    db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'client-delete-run'").run();
    expect((await app.inject({ method: 'DELETE', url: `/admin/clients/${clientId}`, headers })).statusCode).toBe(204);
    expect(db.prepare<[string], { count: number }>(
      'SELECT COUNT(*) AS count FROM credentials WHERE client_id = ?'
    ).get(clientId)?.count).toBe(0);
    expect(db.prepare<[string], { count: number }>(
      'SELECT COUNT(*) AS count FROM grants WHERE client_id = ?'
    ).get(clientId)?.count).toBe(0);
    expect(db.prepare<[], { client_id: string | null }>(
      "SELECT client_id FROM runs WHERE id = 'client-delete-run'"
    ).get()?.client_id).toBeNull();
    expect(json(credential).api_key).toMatch(/^asqsk_/);

    const missing = await app.inject({ method: 'DELETE', url: `/admin/clients/${clientId}`, headers });
    expect(missing.statusCode).toBe(404);
    expect(json(missing)).toMatchObject({ error: { code: 'client_not_found' } });
  });

  it('serves health without authentication and probes the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      ok: true,
      version: AGENT_SQUAD_GATEWAY_VERSION,
      db_ok: true,
      core_url: 'http://127.0.0.1:28771',
    });
  });

  it('returns the exact safe 503 health body when the database probe fails', async () => {
    const unavailableDb = {
      prepare: () => { throw new Error('database connection details must not be exposed'); },
    } as unknown as GatewayDb;
    const unavailableApp = buildGatewayApp({ ...dependencies, db: unavailableDb });
    await unavailableApp.ready();

    try {
      const response = await unavailableApp.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(503);
      expect(json(response)).toEqual({
        ok: false,
        version: AGENT_SQUAD_GATEWAY_VERSION,
        db_ok: false,
        core_url: 'http://127.0.0.1:28771',
      });
    } finally {
      await unavailableApp.close();
    }
  });

  it('bootstraps an authenticated session from the admin-secret Bearer token', async () => {
    const unauthorized = await app.inject({ method: 'POST', url: '/admin/bootstrap/mint' });
    expect(unauthorized.statusCode).toBe(401);
    expect(json(unauthorized)).toMatchObject({ error: { code: 'admin_secret_required' } });

    const invalidBody = await app.inject({
      method: 'POST',
      url: '/admin/bootstrap/mint',
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
      payload: { cwd: '/tmp' },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(json(invalidBody)).toMatchObject({ error: { code: 'validation_error' } });

    const mint = await app.inject({
      method: 'POST',
      url: '/admin/bootstrap/mint',
      headers: { authorization: `Bearer ${ADMIN_SECRET}` },
    });
    expect(mint.statusCode).toBe(200);
    expect(mint.headers['cache-control']).toBe('no-store');
    const code = json(mint).code as string;

    const exchange = await app.inject({
      method: 'POST',
      url: '/admin/bootstrap/exchange',
      payload: { code },
    });
    expect(exchange.statusCode).toBe(200);
    expect(exchange.headers['cache-control']).toBe('no-store');
    expect(exchange.headers['set-cookie']).toMatch(/^asq_gateway_admin=.*; Path=\/admin;/);
    expect(json(exchange)).toMatchObject({
      csrf_token: expect.any(String),
      expires_at: expect.any(String),
    });
  });

  it('rejects unauthenticated requests to every protected admin route', async () => {
    const requests = [
      { method: 'GET' as const, url: '/admin/settings' },
      { method: 'PATCH' as const, url: '/admin/settings/core', payload: { base_url: 'http://localhost:28771' } },
      { method: 'GET' as const, url: '/admin/setup/status' },
      { method: 'POST' as const, url: '/admin/setup/client-credential', payload: { name: 'unreachable' } },
      { method: 'POST' as const, url: '/admin/clients', payload: { name: 'unreachable' } },
      { method: 'GET' as const, url: '/admin/clients' },
      { method: 'GET' as const, url: '/admin/clients/client' },
      { method: 'PATCH' as const, url: '/admin/clients/client', payload: { status: 'disabled' } },
      { method: 'DELETE' as const, url: '/admin/clients/client' },
      { method: 'POST' as const, url: '/admin/clients/client/credentials', payload: { name: 'unreachable' } },
      { method: 'GET' as const, url: '/admin/credentials/credential/reveal' },
      { method: 'POST' as const, url: '/admin/credentials/credential/rotate', payload: { name: 'replacement' } },
      { method: 'POST' as const, url: '/admin/credentials/credential/revoke', payload: {} },
      { method: 'POST' as const, url: '/admin/targets', payload: targetPayload('unreachable') },
      { method: 'PATCH' as const, url: '/admin/targets/unreachable', payload: { enabled: false } },
      { method: 'GET' as const, url: '/admin/targets' },
      { method: 'DELETE' as const, url: '/admin/targets/unreachable' },
      { method: 'GET' as const, url: '/admin/cli-availability' },
      { method: 'POST' as const, url: '/admin/cli-availability/refresh', payload: {} },
      { method: 'GET' as const, url: '/admin/extensions' },
      { method: 'PATCH' as const, url: '/admin/extensions/openai', payload: { enabled: false } },
      { method: 'POST' as const, url: '/admin/targets/unreachable/verify', payload: { confirm_model_usage: true } },
      { method: 'POST' as const, url: '/admin/grants', payload: { client_id: 'client', extension_id: 'openai', target_id: 'target' } },
      { method: 'DELETE' as const, url: '/admin/grants', payload: { client_id: 'client', extension_id: 'openai', target_id: 'target' } },
      { method: 'GET' as const, url: '/admin/runs' },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(json(response)).toEqual({
        error: { code: 'admin_session_required', message: 'admin session required' },
      });
    }
  });

  it('rejects wrong-origin and missing or invalid CSRF requests using the configured gateway origin', async () => {
    const headers = await createSessionHeaders();
    const cases = [
      { name: 'wrong origin', headers: { ...headers, origin: ATTACKER_ORIGIN } },
      { name: 'missing CSRF token', headers: { cookie: headers.cookie, origin: GATEWAY_ORIGIN } },
      { name: 'invalid CSRF token', headers: { ...headers, 'x-csrf-token': 'invalid-csrf-token' } },
    ];

    const mutations = [
      { method: 'PATCH' as const, url: '/admin/settings/core', payload: { base_url: 'http://localhost:28771' } },
      { method: 'POST' as const, url: '/admin/setup/client-credential', payload: { name: 'setup client' } },
      { method: 'PATCH' as const, url: '/admin/clients/client', payload: { status: 'disabled' } },
      { method: 'DELETE' as const, url: '/admin/clients/client' },
      { method: 'POST' as const, url: '/admin/clients/client/credentials', payload: { name: 'key' } },
      { method: 'POST' as const, url: '/admin/credentials/key/rotate', payload: { name: 'replacement' } },
      { method: 'POST' as const, url: '/admin/credentials/key/revoke', payload: {} },
      { method: 'POST' as const, url: '/admin/grants', payload: { client_id: 'client', extension_id: 'openai', target_id: 'target' } },
      { method: 'DELETE' as const, url: '/admin/grants', payload: { client_id: 'client', extension_id: 'openai', target_id: 'target' } },
      { method: 'POST' as const, url: '/admin/targets', payload: targetPayload('csrf-target') },
      { method: 'PATCH' as const, url: '/admin/targets/csrf-target', payload: { enabled: false } },
      { method: 'DELETE' as const, url: '/admin/targets/csrf-target' },
      { method: 'POST' as const, url: '/admin/cli-availability/refresh', payload: {} },
      { method: 'PATCH' as const, url: '/admin/extensions/openai', payload: { enabled: false } },
      { method: 'POST' as const, url: '/admin/targets/csrf-target/verify', payload: { confirm_model_usage: true } },
    ];
    for (const testCase of cases) {
      for (const mutation of mutations) {
        const response = await app.inject({ ...mutation, headers: testCase.headers });
        expect(response.statusCode, `${testCase.name}: ${mutation.method} ${mutation.url}`).toBe(403);
        expect(json(response)).toEqual({ error: { code: 'csrf_invalid', message: 'CSRF validation failed' } });
      }
    }
  });

  it('accepts Vite-origin mutation and rotation but rejects untrusted and cookie-only rotation', async () => {
    const headers = await createSessionHeaders();
    const viteHeaders = { ...headers, origin: VITE_ORIGIN };

    expect((await app.inject({
      method: 'POST', url: '/admin/clients', headers: viteHeaders, payload: { name: 'Vite client' },
    })).statusCode).toBe(201);

    const untrusted = await app.inject({
      method: 'POST', url: '/admin/session/csrf',
      headers: { ...headers, origin: ATTACKER_ORIGIN }, payload: {},
    });
    expect(untrusted.statusCode).toBe(403);

    const cookieOnly = await app.inject({
      method: 'POST', url: '/admin/session/csrf',
      headers: { cookie: headers.cookie, origin: VITE_ORIGIN }, payload: {},
    });
    expect(cookieOnly.statusCode).toBe(403);

    const rotated = await app.inject({
      method: 'POST', url: '/admin/session/csrf', headers: viteHeaders, payload: {},
    });
    expect(rotated.statusCode).toBe(200);
    const nextCsrf = json(rotated).csrf_token as string;
    expect(nextCsrf).not.toBe(headers['x-csrf-token']);

    expect((await app.inject({
      method: 'GET', url: '/admin/clients', headers,
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'GET', url: '/admin/clients',
      headers: { cookie: headers.cookie, 'x-csrf-token': nextCsrf },
    })).statusCode).toBe(200);
  });

  it('rejects cookie-only list and reveal while cookie plus CSRF authorizes both', async () => {
    const headers = await createSessionHeaders();
    const client = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Protected reads' },
    });
    const credential = await app.inject({
      method: 'POST', url: `/admin/clients/${json(client).id as string}/credentials`, headers,
      payload: { name: 'protected key' },
    });
    const revealUrl = `/admin/credentials/${json(credential).id as string}/reveal`;
    const cookieOnly = { cookie: headers.cookie };

    expect((await app.inject({ method: 'GET', url: '/admin/clients', headers: cookieOnly })).statusCode)
      .toBe(403);
    expect((await app.inject({ method: 'GET', url: revealUrl, headers: cookieOnly })).statusCode)
      .toBe(403);
    expect((await app.inject({ method: 'GET', url: '/admin/clients', headers })).statusCode).toBe(200);
    const reveal = await app.inject({ method: 'GET', url: revealUrl, headers });
    expect(reveal.statusCode).toBe(200);
    expect(json(reveal).api_key).toBe(json(credential).api_key);
  });

  it('rejects unknown prohibited properties for every JSON-body route', async () => {
    const headers = await createSessionHeaders();
    const requests = [
      {
        name: 'Core settings update',
        method: 'PATCH' as const,
        url: '/admin/settings/core',
        headers,
        payload: { base_url: 'http://localhost:28771', cwd: '/tmp' },
      },
      {
        name: 'bootstrap mint',
        method: 'POST' as const,
        url: '/admin/bootstrap/mint',
        headers: { authorization: `Bearer ${ADMIN_SECRET}` },
        payload: { cwd: '/tmp' },
      },
      {
        name: 'bootstrap exchange',
        method: 'POST' as const,
        url: '/admin/bootstrap/exchange',
        payload: { code: 'unknown-bootstrap-code', cwd: '/tmp' },
      },
      {
        name: 'setup client and credential create',
        method: 'POST' as const,
        url: '/admin/setup/client-credential',
        headers,
        payload: { name: 'schema setup client', cwd: '/tmp' },
      },
      {
        name: 'client create',
        method: 'POST' as const,
        url: '/admin/clients',
        headers,
        payload: { name: 'schema client', cwd: '/tmp' },
      },
      {
        name: 'credential create',
        method: 'POST' as const,
        url: '/admin/clients/schema-client/credentials',
        headers,
        payload: { name: 'schema credential', cwd: '/tmp' },
      },
      {
        name: 'client delete', method: 'DELETE' as const,
        url: '/admin/clients/schema-client', headers, payload: { cwd: '/tmp' },
      },
      {
        name: 'target create',
        method: 'POST' as const,
        url: '/admin/targets',
        headers,
        payload: { ...targetPayload('schema-target'), cwd: '/tmp' },
      },
      {
        name: 'target update',
        method: 'PATCH' as const,
        url: '/admin/targets/schema-target',
        headers,
        payload: { enabled: false, cwd: '/tmp' },
      },
      {
        name: 'availability refresh', method: 'POST' as const,
        url: '/admin/cli-availability/refresh', headers, payload: { run_model: true },
      },
      {
        name: 'extension update', method: 'PATCH' as const,
        url: '/admin/extensions/openai', headers, payload: { enabled: false, version: 'bad' },
      },
      {
        name: 'target verify', method: 'POST' as const,
        url: '/admin/targets/schema-target/verify', headers,
        payload: { confirm_model_usage: true, expose_raw_output: true },
      },
      {
        name: 'grant create',
        method: 'POST' as const,
        url: '/admin/grants',
        headers,
        payload: { client_id: 'schema-client', extension_id: 'openai', target_id: 'schema-target', cwd: '/tmp' },
      },
    ];

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, request.name).toBe(400);
      expect(json(response)).toEqual({ error: { code: 'validation_error', message: 'invalid request body' } });
    }
  });

  it('normalizes unknown dependency errors without exposing sensitive details', async () => {
    const headers = await createSessionHeaders();
    const sensitiveMessage = 'dependency secret: tenant=acme token=super-secret-value';
    const originalCreate = clients.create;
    clients.create = () => { throw new Error(sensitiveMessage); };

    try {
      const response = await app.inject({
        method: 'POST', url: '/admin/clients', headers, payload: { name: 'error client' },
      });
      expect(response.statusCode).toBe(500);
      expect(json(response)).toEqual({
        error: { code: 'internal_error', message: 'internal gateway error' },
      });
      expect(response.body).not.toContain(sensitiveMessage);
    } finally {
      clients.create = originalCreate;
    }
  });

  it('creates clients and credentials, reveals keys, validates bodies, and returns metadata-only runs', async () => {
    const headers = await createSessionHeaders();

    const invalidClient = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Local LiteLLM', cwd: '/tmp' },
    });
    expect(invalidClient.statusCode).toBe(400);
    expect(json(invalidClient)).toMatchObject({ error: { code: 'validation_error' } });

    const clientResponse = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Local LiteLLM' },
    });
    expect(clientResponse.statusCode).toBe(201);
    const client = json(clientResponse);

    const credentialResponse = await app.inject({
      method: 'POST',
      url: `/admin/clients/${client.id as string}/credentials`,
      headers,
      payload: { name: 'primary' },
    });
    expect(credentialResponse.statusCode).toBe(201);
    expect(credentialResponse.headers['cache-control']).toBe('no-store');
    const credential = json(credentialResponse);
    expect(credential.api_key).toMatch(/^asqsk_/);

    const reveal = await app.inject({
      method: 'GET', url: `/admin/credentials/${credential.id as string}/reveal`, headers,
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.headers['cache-control']).toBe('no-store');
    expect(json(reveal)).toEqual({ api_key: credential.api_key });

    const run = db.prepare(`
      INSERT INTO runs (id, client_id, extension_id, target_id, endpoint, status, response_id, queued_at)
      VALUES ('run_test', ?, 'openai', 'target', '/v1/responses', 'queued', 'resp_test', ?)
    `).run(client.id, new Date().toISOString());
    expect(run.changes).toBe(1);
    const runs = await app.inject({ method: 'GET', url: '/admin/runs', headers });
    expect(runs.statusCode).toBe(200);
    expect(json(runs)).toEqual({
      runs: [expect.objectContaining({ id: 'run_test' })],
      verifiedTargetCount: 0,
    });
    expect(JSON.stringify(json(runs))).not.toMatch(/prompt|completion|raw/i);
  });

  it('creates disabled targets, requires best-effort opt-in, and grants targets', async () => {
    const headers = await createSessionHeaders();
    const client = await app.inject({
      method: 'POST', url: '/admin/clients', headers, payload: { name: 'Grant client' },
    });
    const clientId = json(client).id as string;
    db.prepare(`
      INSERT INTO extensions (id, version, enabled, created_at, updated_at)
      VALUES ('openai', '1.0.0', 1, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());

    const targetResponse = await app.inject({
      method: 'POST',
      url: '/admin/targets',
      headers,
      payload: targetPayload('codex-gpt56-max'),
    });
    expect(targetResponse.statusCode).toBe(201);
    expect(json(targetResponse)).toMatchObject({
      enabled: false,
      capabilityVersion: null,
      capabilityVerifiedAt: null,
      capabilities: null,
    });

    const invalidEnable = await app.inject({
      method: 'PATCH',
      url: '/admin/targets/codex-gpt56-max',
      headers,
      payload: { enabled: true },
    });
    expect(invalidEnable.statusCode).toBe(409);
    expect(json(invalidEnable)).toMatchObject({ error: { code: 'capability_verification_required' } });

    db.prepare(`
      UPDATE invocation_targets
      SET capability_version = '1.2.0', capability_verified_at = '2026-07-10T12:00:00.000Z',
          capability_json = ?
      WHERE id = 'codex-gpt56-max'
    `).run(JSON.stringify({
      isolationLevel: 'best_effort', streamingMode: 'native', toolBridge: 'structured_output',
      resume: true, cancellation: true, modelSelection: true, effortSelection: true,
    }));

    const optInRequired = await app.inject({
      method: 'PATCH',
      url: '/admin/targets/codex-gpt56-max',
      headers,
      payload: { enabled: true },
    });
    expect(optInRequired.statusCode).toBe(409);
    expect(json(optInRequired)).toMatchObject({ error: { code: 'best_effort_acknowledgement_required' } });

    const enabled = await app.inject({
      method: 'PATCH',
      url: '/admin/targets/codex-gpt56-max',
      headers,
      payload: { enabled: true, enabled_best_effort: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(json(enabled)).toMatchObject({ enabled: true });

    const grant = await app.inject({
      method: 'POST',
      url: '/admin/grants',
      headers,
      payload: { client_id: clientId, extension_id: 'openai', target_id: 'codex-gpt56-max' },
    });
    expect(grant.statusCode).toBe(201);
    expect(json(grant)).toEqual({ clientId, extensionId: 'openai', targetId: 'codex-gpt56-max' });
  });

  it('creates and verifies a target in one explicitly confirmed request', async () => {
    const headers = await createSessionHeaders();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/targets',
      headers,
      payload: {
        ...targetPayload('create-and-verify'),
        verify_on_create: true,
        confirm_model_usage: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json(response)).toMatchObject({
      target: {
        id: 'create-and-verify',
        enabled: false,
        capabilityVersion: '1.2.0',
        capabilityVerifiedAt: '2026-07-12T12:31:00.000Z',
        capabilityError: null,
      },
      capabilities: { available: true, verified: true, version: '1.2.0' },
      model_usage_consumed: true,
    });
    expect(capabilityVerifyCount).toBe(1);
  });

  it('requires model-use confirmation and removes a new target when verification fails', async () => {
    const headers = await createSessionHeaders();
    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/admin/targets',
      headers,
      payload: { ...targetPayload('unconfirmed-target'), verify_on_create: true },
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(json(unconfirmed)).toMatchObject({ error: { code: 'model_usage_confirmation_required' } });
    expect(targets.get('unconfirmed-target')).toBeNull();

    capabilityFailure = new Error('verification failed');
    const failed = await app.inject({
      method: 'POST',
      url: '/admin/targets',
      headers,
      payload: {
        ...targetPayload('failed-create-and-verify'),
        verify_on_create: true,
        confirm_model_usage: true,
      },
    });
    expect(failed.statusCode).toBe(500);
    expect(targets.get('failed-create-and-verify')).toBeNull();
    expect(capabilityVerifyCount).toBe(1);
  });

  it('covers Task 4 target, availability, extension, verification, and safe-error boundaries', async () => {
    const headers = await createSessionHeaders();
    await app.inject({ method: 'POST', url: '/admin/targets', headers, payload: targetPayload('task4-target') });

    const listed = await app.inject({ method: 'GET', url: '/admin/targets', headers });
    expect(listed.statusCode).toBe(200);
    expect(json(listed)).toMatchObject({ targets: [expect.objectContaining({ id: 'task4-target' })] });

    const availability = await app.inject({ method: 'GET', url: '/admin/cli-availability', headers });
    expect(availability.statusCode).toBe(200);
    expect(json(availability)).toMatchObject({
      cli_availability: [expect.objectContaining({
        cli: 'codex', capabilities: expect.objectContaining({ version: '1.2.0' }),
      })],
    });
    expect(availability.body).not.toMatch(/stdout|stderr|raw_output/i);

    const refresh = await app.inject({ method: 'POST', url: '/admin/cli-availability/refresh', headers, payload: {} });
    expect(refresh.statusCode).toBe(200);
    expect(capabilityScanCount).toBe(1);
    expect(capabilityVerifyCount).toBe(0);

    const verify = await app.inject({
      method: 'POST', url: '/admin/targets/task4-target/verify', headers,
      payload: { confirm_model_usage: true },
    });
    expect(verify.statusCode).toBe(200);
    expect(json(verify)).toMatchObject({ model_usage_consumed: true, capabilities: { version: '1.2.0' } });
    expect(capabilityVerifyCount).toBe(1);
    expect(verify.body).not.toMatch(/stdout|stderr|raw_output/i);

    staticCapabilityVersion = '2.0.0';
    const versionMismatch = await app.inject({
      method: 'PATCH', url: '/admin/targets/task4-target', headers,
      payload: { enabled: true, enabled_best_effort: true },
    });
    expect(versionMismatch.statusCode).toBe(409);
    expect(json(versionMismatch)).toMatchObject({ error: { code: 'capability_mismatch' } });
    staticCapabilityVersion = '1.2.0';

    const extension = await app.inject({ method: 'PATCH', url: '/admin/extensions/openai', headers, payload: { enabled: false } });
    expect(extension.statusCode).toBe(200);
    expect(extensions.list()).toEqual([expect.objectContaining({ id: 'openai', enabled: false })]);
    expect(json(await app.inject({ method: 'GET', url: '/admin/extensions', headers })))
      .toMatchObject({ extensions: [expect.objectContaining({ id: 'openai', enabled: false })] });

    const enable = await app.inject({
      method: 'PATCH', url: '/admin/targets/task4-target', headers,
      payload: { enabled: true, enabled_best_effort: true },
    });
    expect(enable.statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/admin/targets/task4-target', headers })).statusCode).toBe(409);

    const changed = await app.inject({
      method: 'PATCH', url: '/admin/targets/task4-target', headers,
      payload: { native_model: 'gpt-next' },
    });
    expect(json(changed)).toMatchObject({
      enabled: false, nativeModel: 'gpt-next', capabilityVersion: null,
      capabilityVerifiedAt: null, capabilities: null, capabilityError: 'configuration_changed',
    });
    const staleEnable = await app.inject({
      method: 'PATCH', url: '/admin/targets/task4-target', headers, payload: { enabled: true },
    });
    expect(staleEnable.statusCode).toBe(409);
    expect(json(staleEnable)).toMatchObject({ error: { code: 'capability_verification_required' } });

    const client = clients.create('delete conflict client');
    db.prepare(`
      INSERT INTO runs (id, client_id, extension_id, target_id, endpoint, status, queued_at)
      VALUES ('run_delete_conflict', ?, 'openai', 'task4-target', '/v1/responses', 'queued', ?)
    `).run(client.id, new Date().toISOString());
    const inUseDelete = await app.inject({ method: 'DELETE', url: '/admin/targets/task4-target', headers });
    expect(inUseDelete.statusCode).toBe(409);
    expect(json(inUseDelete)).toMatchObject({ error: { code: 'target_in_use' } });
    db.prepare("UPDATE runs SET status = 'completed', completed_at = ? WHERE id = 'run_delete_conflict'")
      .run(new Date().toISOString());

    capabilityFailure = new Error('CLI stderr secret-token raw output');
    const failedVerify = await app.inject({
      method: 'POST', url: '/admin/targets/task4-target/verify', headers,
      payload: { confirm_model_usage: true },
    });
    expect(failedVerify.statusCode).toBe(500);
    expect(json(failedVerify)).toEqual({ error: { code: 'internal_error', message: 'internal gateway error' } });
    expect(failedVerify.body).not.toContain('secret-token');

    expect((await app.inject({ method: 'DELETE', url: '/admin/targets/task4-target', headers })).statusCode).toBe(204);
  });
});
