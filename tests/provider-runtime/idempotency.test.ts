import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import {
  IdempotencyConflictError,
  IdempotencyService,
  canonicalizeRequest,
} from '../../src/control-plane/idempotency.js';
import { ResponseSessionRepository } from '../../src/control-plane/response-sessions.js';
import { reserveRunId, RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import type { InvocationRequest } from '../../src/provider-runtime/invocation-service.js';
import {
  ReplayBuffer,
  ReplayUnavailableError,
} from '../../src/provider-runtime/replay-buffer.js';
import type { ProviderEvent } from '../../src/provider-runtime/types.js';
import type { WorkspaceLease } from '../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../src/server/app.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const VERIFIED_CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = [];
  for await (const value of source) values.push(value);
  return values;
}

describe('ReplayBuffer', () => {
  it('replays ordered publications to concurrent and completed subscribers', async () => {
    let now = 1_000;
    const replay = new ReplayBuffer({ now: () => now });
    replay.open('run-1');
    const concurrent = collect(replay.subscribe('run-1'));

    replay.publish('run-1', 'first');
    replay.publish('run-1', 'second');
    replay.complete('run-1');

    await expect(concurrent).resolves.toEqual(['first', 'second']);
    await expect(collect(replay.subscribe('run-1'))).resolves.toEqual(['first', 'second']);
    expect(replay.sizeBytes).toBe(Buffer.byteLength('firstsecond'));

    now += 10 * MINUTE_MS;
    expect(() => replay.subscribe('run-1')).toThrow(ReplayUnavailableError);
    expect(replay.sizeBytes).toBe(0);
  });

  it('uses byte-accurate global LRU eviction and wakes evicted subscribers', async () => {
    const replay = new ReplayBuffer({ maxBytes: 6 });
    replay.publish('a', '\u03bb\u03bb');
    replay.publish('b', '12');
    const waiting = collect(replay.subscribe('b'));
    replay.subscribe('a');
    replay.publish('c', '34');

    await expect(waiting).rejects.toBeInstanceOf(ReplayUnavailableError);
    expect(() => replay.subscribe('b')).toThrow(ReplayUnavailableError);
    await expect(collect((replay.complete('a'), replay.subscribe('a')))).resolves.toEqual(['\u03bb\u03bb']);
    expect(replay.sizeBytes).toBe(6);
  });

  it('does not affect the owner buffer when a subscriber cancels', async () => {
    const replay = new ReplayBuffer();
    replay.open('owner');
    const subscriber = replay.subscribe('owner')[Symbol.asyncIterator]();
    await subscriber.return?.();
    replay.publish('owner', 'result');
    replay.complete('owner');
    await expect(collect(replay.subscribe('owner'))).resolves.toEqual(['result']);
  });
});

describe('IdempotencyService', () => {
  let db: GatewayDb | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    db = undefined;
    directory = undefined;
  });

  it('sorts every object lexically while preserving array order', () => {
    expect(canonicalizeRequest({ 2: 'two', 10: 'ten', z: [{ b: 2, a: 1 }, { d: 4, c: 3 }] }))
      .toBe('{"10":"ten","2":"two","z":[{"a":1,"b":2},{"c":3,"d":4}]}');
  });

  it('canonicalizes requests, persists hashes and IDs only, and refuses replay after restart', () => {
    directory = mkdtempSync(join(tmpdir(), 'gateway-idempotency-'));
    const path = join(directory, 'gateway.db');
    let now = Date.parse('2026-07-11T00:00:00.000Z');
    db = openGatewayDb(path);
    const client = new ClientRepository(db).create('idempotency-client');
    const runs = new RunRepository(db);
    const replay = new ReplayBuffer({ now: () => now });
    const service = new IdempotencyService(db, runs, replay, { now: () => now });
    const runId = reserveRunId();
    const first = service.begin({
      clientId: client.id,
      key: 'raw-secret-key',
      endpoint: 'chat.completions',
      request: { z: 1, nested: { b: 2, a: 1 }, array: [{ y: 2, x: 1 }, 3] },
      runId,
      run: { clientId: client.id, extensionId: 'openai', targetId: 'model', endpoint: 'chat.completions' },
    });
    expect(first).toMatchObject({ type: 'owner', runId });

    const row = db.prepare<[], Record<string, string>>('SELECT * FROM idempotency_keys').get()!;
    expect(Object.keys(row).sort()).toEqual([
      'client_id', 'expires_at', 'key_digest', 'request_hash', 'response_id', 'run_id', 'status',
    ]);
    expect(row.key_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('raw-secret-key');
    expect(JSON.stringify(row)).not.toContain('nested');
    expect(Date.parse(row.expires_at) - now).toBe(30 * DAY_MS);
    expect(runs.get(runId)).toMatchObject({ id: runId, status: 'queued' });

    db.close();
    db = openGatewayDb(path);
    const restarted = new IdempotencyService(
      db,
      new RunRepository(db),
      new ReplayBuffer({ now: () => now }),
      { now: () => now },
    );
    expect(restarted.begin({
      clientId: client.id,
      key: 'raw-secret-key',
      endpoint: 'chat.completions',
      request: { array: [{ x: 1, y: 2 }, 3], nested: { a: 1, b: 2 }, z: 1 },
      runId: reserveRunId(),
      run: { clientId: client.id, extensionId: 'openai', targetId: 'model', endpoint: 'chat.completions' },
    })).toMatchObject({ type: 'unavailable', runId });
    expect(() => restarted.begin({
      clientId: client.id,
      key: 'raw-secret-key',
      endpoint: 'chat.completions',
      request: { z: 2 },
      runId: reserveRunId(),
      run: { clientId: client.id, extensionId: 'openai', targetId: 'model', endpoint: 'chat.completions' },
    })).toThrow(IdempotencyConflictError);
    expect(new RunRepository(db).list()).toHaveLength(1);

    now += 30 * DAY_MS + 1;
    expect(restarted.begin({
      clientId: client.id,
      key: 'raw-secret-key',
      endpoint: 'chat.completions',
      request: { z: 2 },
      runId: reserveRunId(),
      run: { clientId: client.id, extensionId: 'openai', targetId: 'model', endpoint: 'chat.completions' },
    }).type).toBe('owner');
  });

  it('returns active duplicates and completed replay without creating another Run', async () => {
    db = openGatewayDb(':memory:');
    const client = new ClientRepository(db).create('concurrent-client');
    const runs = new RunRepository(db);
    const service = new IdempotencyService(db, runs, new ReplayBuffer());
    const input = () => ({
      clientId: client.id,
      key: 'same-key',
      endpoint: 'responses',
      request: { model: 'm', input: ['one', 'two'] },
      runId: reserveRunId(),
      responseId: 'resp-owner',
      run: {
        clientId: client.id,
        extensionId: 'openai',
        targetId: 'm',
        endpoint: 'responses',
        responseId: 'resp-owner',
      },
    });
    const owner = service.begin(input());
    const duplicate = service.begin(input());
    expect(owner.type).toBe('owner');
    expect(duplicate).toMatchObject({ type: 'active_duplicate', runId: owner.runId });
    const attached = service.attach(duplicate);
    service.complete(owner, '{"safe":"result"}');
    await expect(attached).resolves.toEqual(['{"safe":"result"}']);
    expect(service.begin(input())).toMatchObject({ type: 'completed_replay', runId: owner.runId });
    expect(runs.list()).toHaveLength(1);
  });

  it('keeps 30-day metadata after the 10-minute completed replay expires', () => {
    let now = 1_000;
    db = openGatewayDb(':memory:');
    const client = new ClientRepository(db).create('ttl-client');
    const runs = new RunRepository(db);
    const service = new IdempotencyService(
      db,
      runs,
      new ReplayBuffer({ now: () => now }),
      { now: () => now },
    );
    const input = () => ({
      clientId: client.id,
      key: 'ttl-key',
      endpoint: 'chat.completions',
      request: { prompt: 'safe hash only' },
      runId: reserveRunId(),
      run: { clientId: client.id, extensionId: 'openai', targetId: 'm', endpoint: 'chat.completions' },
    });
    const owner = service.begin(input());
    service.complete(owner, '{"ok":true}');
    now += 10 * MINUTE_MS;

    expect(service.begin(input())).toMatchObject({ type: 'unavailable', runId: owner.runId });
    expect(runs.list()).toHaveLength(1);
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM idempotency_keys').get()?.count).toBe(1);
  });

  it('does not resurrect an owner buffer after explicit eviction', () => {
    db = openGatewayDb(':memory:');
    const client = new ClientRepository(db).create('evicted-client');
    const runs = new RunRepository(db);
    const replay = new ReplayBuffer();
    const service = new IdempotencyService(db, runs, replay);
    const input = () => ({
      clientId: client.id,
      key: 'evicted-key',
      endpoint: 'chat.completions',
      request: { model: 'm' },
      runId: reserveRunId(),
      run: { clientId: client.id, extensionId: 'openai', targetId: 'm', endpoint: 'chat.completions' },
    });
    const owner = service.begin(input());
    replay.evict(owner.runId);
    service.complete(owner, '{"ok":true}');

    expect(service.begin(input())).toMatchObject({ type: 'unavailable', runId: owner.runId });
    expect(runs.list()).toHaveLength(1);
  });
});

class FakeInvocationService {
  readonly requests: InvocationRequest[] = [];
  readonly release = deferred<void>();
  block = false;
  fail = false;
  onInvoke: ((request: InvocationRequest) => void) | undefined;

  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    this.onInvoke?.(request);
    const wait = this.block ? this.release.promise : Promise.resolve();
    const fail = this.fail;
    return (async function* () {
      await wait;
      yield { type: 'session_started', nativeSessionId: 'native-session' };
      if (fail) {
        yield { type: 'failed', code: 'provider_failed', message: 'secret provider detail', nativeStateAdvanced: true };
      } else {
        yield { type: 'text_delta', delta: 'Hello' };
        yield { type: 'completed' };
      }
    })();
  }
}

class FakeResponseWorkspaces {
  readonly created: string[] = [];
  async createResponse(_target: InvocationTarget, responseId: string): Promise<WorkspaceLease> {
    this.created.push(responseId);
    return { path: `/responses/${responseId}`, release: async () => undefined };
  }
  async cleanupExpired(): Promise<void> {}
}

describe('OpenAI idempotency integration', () => {
  let app: FastifyInstance | undefined;
  let db: GatewayDb | undefined;
  let apiKey = '';
  let invocations: FakeInvocationService;
  let sessions: ResponseSessionRepository;

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = undefined;
    db = undefined;
  });

  async function setup(): Promise<void> {
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const credentials = new CredentialService(db, Buffer.alloc(32, 1));
    const extensions = new ExtensionRepository(db);
    const grants = new GrantRepository(db);
    const targets = new TargetRepository(db);
    const runs = new RunRepository(db);
    sessions = new ResponseSessionRepository(db);
    invocations = new FakeInvocationService();
    const workspaces = new FakeResponseWorkspaces();
    app = buildGatewayApp({
      config: resolveGatewayConfig({ baseDir: '/tmp/asq-gateway-idempotency-test' }),
      db,
      clients,
      credentials,
      extensions,
      grants,
      targets,
      runs,
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 2)),
      invocationService: invocations,
      responseSessions: sessions,
      responseWorkspaces: workspaces,
    });
    const client = clients.create('route-client');
    apiKey = credentials.create(client.id, 'primary').apiKey;
    extensions.upsert('openai', '1.0.0', true);
    targets.create({
      id: 'model', cli: 'fake', nativeModel: 'native', isolationLevel: 'strict',
      streamingMode: 'native', toolBridge: 'structured_output',
    });
    targets.setCapability('model', {
      version: '1.0.0', verifiedAt: new Date().toISOString(), capabilities: VERIFIED_CAPABILITIES,
    });
    targets.update('model', { enabled: true });
    grants.grant(client.id, 'openai', 'model');
    await app.ready();
  }

  function post(url: string, payload: unknown, key: string) {
    return app!.inject({
      method: 'POST', url,
      headers: { authorization: `Bearer ${apiKey}`, 'idempotency-key': key },
      payload,
    });
  }

  it('deduplicates concurrent Chat requests and replays the identical final response', async () => {
    await setup();
    invocations.block = true;
    invocations.onInvoke = (request) => {
      expect(request.runId).toMatch(/^run_/);
      expect(db!.prepare<[string], { id: string }>('SELECT id FROM runs WHERE id = ?').get(request.runId!)).toBeTruthy();
    };
    const body = { model: 'model', messages: [{ role: 'user', content: 'hello' }] };
    const owner = post('/v1/chat/completions', body, 'chat-key');
    await vi.waitFor(() => expect(invocations.requests).toHaveLength(1));
    const duplicate = post('/v1/chat/completions', body, 'chat-key');
    invocations.release.resolve();
    const [first, second] = await Promise.all([owner, duplicate]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(invocations.requests).toHaveLength(1);

    const replay = await post('/v1/chat/completions', body, 'chat-key');
    expect(replay.json()).toEqual(first.json());
    expect(invocations.requests).toHaveLength(1);
    const conflict = await post(
      '/v1/chat/completions',
      { model: 'model', messages: [{ role: 'user', content: 'different' }] },
      'chat-key',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });
    expect(invocations.requests).toHaveLength(1);
  });

  it('scopes the same key across Chat and Responses and preserves response sessions on replay', async () => {
    await setup();
    const chat = await post(
      '/v1/chat/completions',
      { model: 'model', messages: [{ role: 'user', content: 'hello' }] },
      'shared-key',
    );
    const response = await post('/v1/responses', { model: 'model', input: 'hello' }, 'shared-key');
    const replay = await post('/v1/responses', { input: 'hello', model: 'model' }, 'shared-key');

    expect(chat.statusCode).toBe(200);
    expect(response.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(invocations.requests).toHaveLength(2);
    expect(db!.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM response_sessions').get()?.count).toBe(1);
  });

  it('settles owner failure and wakes a concurrent duplicate with the same safe error', async () => {
    await setup();
    invocations.block = true;
    invocations.fail = true;
    const body = { model: 'model', messages: [{ role: 'user', content: 'fail' }] };
    const owner = post('/v1/chat/completions', body, 'failure-key');
    await vi.waitFor(() => expect(invocations.requests).toHaveLength(1));
    const duplicate = post('/v1/chat/completions', body, 'failure-key');
    invocations.release.resolve();
    const [first, second] = await Promise.all([owner, duplicate]);

    expect(first.statusCode).toBe(502);
    expect(second.statusCode).toBe(502);
    expect(second.json()).toEqual(first.json());
    expect(JSON.stringify(first.json())).not.toContain('secret provider detail');
    expect(invocations.requests).toHaveLength(1);
    expect(db!.prepare<[], { status: string }>('SELECT status FROM idempotency_keys').get()?.status).toBe('failed');
  });
});
