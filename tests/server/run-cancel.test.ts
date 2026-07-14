import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { ensureSecretFile } from '../../src/security/secret-files.js';
import { buildGatewayApp, type GatewayAppDependencies } from '../../src/server/app.js';

const ADMIN_SECRET_BYTES = Buffer.from('local-admin-secret');
const ADMIN_SECRET = ADMIN_SECRET_BYTES.toString('base64url');
const GATEWAY_ORIGIN = 'http://127.0.0.1:28772';

let app: FastifyInstance;
let db: GatewayDb;
let baseDir: string;
let runs: RunRepository;
let clients: ClientRepository;
let cancelRun: ReturnType<typeof vi.fn<(runId: string) => Promise<boolean>>>;

function json(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

async function sessionHeaders(): Promise<Record<string, string>> {
  const mint = await app.inject({
    method: 'POST',
    url: '/admin/bootstrap/mint',
    headers: { authorization: `Bearer ${ADMIN_SECRET}` },
  });
  const exchange = await app.inject({
    method: 'POST',
    url: '/admin/bootstrap/exchange',
    payload: { code: json(mint).code },
  });
  return {
    cookie: exchange.headers['set-cookie']!.split(';', 1)[0]!,
    origin: GATEWAY_ORIGIN,
    'x-csrf-token': json(exchange).csrf_token as string,
  };
}

function target(): InvocationTarget {
  return {
    id: 'target-a',
    aliases: [],
    cli: 'fake',
    nativeModel: 'fake',
    reasoningEffort: null,
    enabled: true,
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 1_000,
    runTimeoutMs: null,
    fixedWorkspace: null,
    capabilityVersion: null,
    capabilityVerifiedAt: null,
    capabilities: null,
    capabilityError: null,
    createdAt: '2026-07-12T12:00:00.000Z',
    updatedAt: '2026-07-12T12:00:00.000Z',
  };
}

beforeEach(async () => {
  baseDir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-run-cancel-'));
  const config = resolveGatewayConfig({ baseDir, webUiAuth: 'token' });
  const masterKey = ensureSecretFile(config.paths.masterKeyPath, 32);
  fs.writeFileSync(config.paths.adminSecretPath, ADMIN_SECRET_BYTES, { mode: 0o600 });
  db = openGatewayDb(':memory:');
  runs = new RunRepository(db);
  cancelRun = vi.fn(async () => true);
  const dependencies: GatewayAppDependencies = {
    config,
    db,
    clients: clients = new ClientRepository(db),
    credentials: new CredentialService(db, masterKey),
    targets: new TargetRepository(db),
    grants: new GrantRepository(db),
    extensions: new ExtensionRepository(db),
    runs,
    adminAuth: new AdminAuthService(db, ADMIN_SECRET_BYTES),
    invocationService: {
      async *invoke() {},
      cancel: cancelRun,
    } as GatewayAppDependencies['invocationService'],
  };
  app = buildGatewayApp(dependencies);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('Gateway API run cancellation', () => {
  it('filters and limits Gateway runs using the admin query contract', async () => {
    const firstClient = clients.create('first client');
    const secondClient = clients.create('second client');
    runs.create({
      clientId: firstClient.id,
      extensionId: 'openai',
      targetId: 'target-a',
      endpoint: '/v1/responses',
    }, 'run_match');
    runs.markStarted('run_match');
    runs.create({
      clientId: secondClient.id,
      extensionId: 'openai',
      targetId: 'target-b',
      endpoint: '/v1/chat/completions',
    }, 'run_other');

    const filters = new URLSearchParams({
      limit: '1',
      status: 'running',
      target_id: 'target-a',
      client_id: firstClient.id,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/admin/runs?${filters.toString()}`,
      headers: await sessionHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({
      runs: [expect.objectContaining({ id: 'run_match' })],
      verifiedTargetCount: 0,
    });

    const invalid = await app.inject({
      method: 'GET',
      url: '/admin/runs?limit=0&status=not-a-status',
      headers: await sessionHeaders(),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns complete active aggregates independently of the latest run limit', async () => {
    runs.create({ extensionId: 'openai', targetId: 'target-active', endpoint: '/v1/responses' }, 'run_old_active');
    for (let index = 0; index < 21; index += 1) {
      const id = `run_terminal_${index}`;
      runs.create({ extensionId: 'openai', targetId: 'target-terminal', endpoint: '/v1/responses' }, id);
      runs.markStarted(id);
      runs.markFinished(id, 'completed');
    }

    const response = await app.inject({
      method: 'GET',
      url: '/admin/runs/overview',
      headers: await sessionHeaders(),
    });
    const payload = json(response) as {
      runs: Array<{ id: string }>;
      activeRunCount: number;
      queuePressure: Array<{ targetId: string; queued: number; running: number }>;
    };

    expect(response.statusCode).toBe(200);
    expect(payload.runs).toHaveLength(20);
    expect(payload.runs.map((run) => run.id)).not.toContain('run_old_active');
    expect(payload.activeRunCount).toBe(1);
    expect(payload.queuePressure).toEqual([
      { targetId: 'target-active', queued: 1, running: 0 },
    ]);
  });

  it('removes a queued Gateway run from its scheduler', async () => {
    const scheduler = new TargetScheduler();
    let releaseActive!: () => void;
    const active = scheduler.run(
      'run_active',
      target(),
      new AbortController().signal,
      () => new Promise<void>((resolve) => { releaseActive = resolve; }),
    );
    const queued = scheduler.run(
      'run_queued',
      target(),
      new AbortController().signal,
      async () => undefined,
    );
    const queuedResult = queued.catch((error: unknown) => error);
    cancelRun.mockImplementation(async (runId) => scheduler.cancelQueued(runId));
    runs.create({ extensionId: 'openai', targetId: 'target-a', endpoint: '/v1/responses' }, 'run_queued');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/runs/run_queued/cancel',
      headers: await sessionHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(cancelRun).toHaveBeenCalledWith('run_queued');
    expect(await queuedResult).toMatchObject({ name: 'AbortError' });
    expect(scheduler.cancelQueued('run_queued')).toBe(false);
    releaseActive();
    await active;
  });

  it('delegates running cancellation to InvocationService.cancel', async () => {
    runs.create({ extensionId: 'openai', targetId: 'target-a', endpoint: '/v1/responses' }, 'run_running');
    runs.markStarted('run_running');

    const response = await app.inject({
      method: 'POST',
      url: '/admin/runs/run_running/cancel',
      headers: await sessionHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ cancelled: true, id: 'run_running' });
    expect(cancelRun).toHaveBeenCalledWith('run_running');
  });

  it('returns conflicts for terminal runs and not found for unknown or Core identifiers', async () => {
    runs.create({ extensionId: 'openai', targetId: 'target-a', endpoint: '/v1/responses' }, 'run_done');
    runs.markStarted('run_done');
    runs.markFinished('run_done', 'completed');
    const headers = await sessionHeaders();

    const completed = await app.inject({
      method: 'POST', url: '/admin/runs/run_done/cancel', headers,
    });
    expect(completed.statusCode).toBe(409);
    expect(json(completed)).toMatchObject({ error: { code: 'run_not_cancellable' } });

    for (const id of ['run_missing', 'sess_core_1', 'subagent_core_1']) {
      const response = await app.inject({
        method: 'POST', url: `/admin/runs/${id}/cancel`, headers,
      });
      expect(response.statusCode).toBe(404);
      expect(json(response)).toMatchObject({ error: { code: 'run_not_found' } });
    }
    expect(cancelRun).not.toHaveBeenCalled();
  });
});
