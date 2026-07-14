import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGatewayConfig } from '../../../src/config/config.js';
import { ClientRepository } from '../../../src/control-plane/clients.js';
import { CredentialService } from '../../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../../src/control-plane/db.js';
import { ExtensionRepository } from '../../../src/control-plane/extensions.js';
import { GrantRepository } from '../../../src/control-plane/grants.js';
import { IdempotencyService } from '../../../src/control-plane/idempotency.js';
import { ResponseSessionRepository } from '../../../src/control-plane/response-sessions.js';
import { RunRepository } from '../../../src/control-plane/runs.js';
import { TargetRepository } from '../../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../../src/control-plane/types.js';
import type { InvocationRequest } from '../../../src/provider-runtime/invocation-service.js';
import type { ProviderEvent } from '../../../src/provider-runtime/types.js';
import { ReplayBuffer } from '../../../src/provider-runtime/replay-buffer.js';
import type { WorkspaceLease } from '../../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../../src/server/app.js';

const VERIFIED_CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledEvents implements AsyncIterableIterator<ProviderEvent> {
  private index = 0;
  private closed = false;
  readonly release = deferred();
  readonly returned = deferred();

  constructor(
    private readonly events: ProviderEvent[],
    private readonly gateAt = Number.POSITIVE_INFINITY,
  ) {}

  async next(): Promise<IteratorResult<ProviderEvent>> {
    if (this.closed) return { done: true, value: undefined };
    if (this.index === this.gateAt) {
      await Promise.race([this.release.promise, this.returned.promise]);
    }
    if (this.closed || this.index >= this.events.length) {
      return { done: true, value: undefined };
    }
    return { done: false, value: this.events[this.index++]! };
  }

  async return(): Promise<IteratorResult<ProviderEvent>> {
    this.closed = true;
    this.returned.resolve();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<ProviderEvent> {
    return this;
  }
}

class FakeInvocationService {
  readonly requests: InvocationRequest[] = [];
  current = new ControlledEvents([{ type: 'completed' }]);

  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    return this.current;
  }
}

class FakeResponseWorkspaces {
  releaseError: Error | undefined;
  releaseCalls = 0;

  async createResponse(_target: InvocationTarget, responseId: string): Promise<WorkspaceLease> {
    return {
      path: `/responses/${responseId}`,
      release: async () => {
        this.releaseCalls += 1;
        if (this.releaseError) throw this.releaseError;
      },
    };
  }

  async cleanupExpired(_paths: string[]): Promise<void> {}
}

interface WireResponse {
  response: http.IncomingMessage;
  chunks: string[];
  firstFrame: Promise<void>;
  ended: Promise<void>;
  destroy: () => void;
}

let app: FastifyInstance;
let db: GatewayDb;
let invocations: FakeInvocationService;
let idempotency: IdempotencyService;
let sessions: ResponseSessionRepository;
let workspaces: FakeResponseWorkspaces;
let apiKey: string;
let port: number;

function createTarget(targets: TargetRepository): InvocationTarget {
  const target = targets.create({
    id: 'model', aliases: [], cli: 'codex', nativeModel: 'gpt-5.6', reasoningEffort: 'max',
    isolationLevel: 'strict', streamingMode: 'native', toolBridge: 'structured_output',
    maxConcurrency: 1, maxQueue: 8, queueTimeoutMs: 300_000, runTimeoutMs: null,
  });
  targets.setCapability(target.id, {
    version: '1.0.0', verifiedAt: '2026-07-10T12:00:00.000Z', capabilities: VERIFIED_CAPABILITIES,
  });
  return targets.update(target.id, { enabled: true });
}

async function openStream(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<WireResponse> {
  const first = deferred();
  const end = deferred();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...headers,
      },
    }, (response) => {
      const chunks: string[] = [];
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        chunks.push(chunk);
        if (chunks.join('').includes('\n\n')) first.resolve();
      });
      response.on('end', end.resolve);
      response.on('error', () => end.resolve());
      resolve({
        response,
        chunks,
        firstFrame: first.promise,
        ended: end.promise,
        destroy: () => request.destroy(),
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function dataFrames(wire: string): Array<string | Record<string, unknown>> {
  return wire.split('\n\n').flatMap((frame) => {
    if (!frame.startsWith('data: ')) return [];
    const data = frame.slice(6);
    return [data === '[DONE]' ? data : JSON.parse(data) as Record<string, unknown>];
  });
}

beforeEach(async () => {
  db = openGatewayDb(':memory:');
  const clients = new ClientRepository(db);
  const credentials = new CredentialService(db, Buffer.alloc(32, 5));
  const extensions = new ExtensionRepository(db);
  const grants = new GrantRepository(db);
  const targets = new TargetRepository(db);
  const runs = new RunRepository(db);
  const replayBuffer = new ReplayBuffer();
  invocations = new FakeInvocationService();
  idempotency = new IdempotencyService(db, runs, replayBuffer);
  sessions = new ResponseSessionRepository(db);
  workspaces = new FakeResponseWorkspaces();
  app = buildGatewayApp({
    config: resolveGatewayConfig({ baseDir: '/tmp/asq-gateway-streaming-test' }),
    db, clients, credentials, extensions, grants, targets, runs,
    adminAuth: new AdminAuthService(db, Buffer.alloc(32, 7)),
    invocationService: invocations,
    responseSessions: sessions,
    responseWorkspaces: workspaces,
    replayBuffer,
    idempotency,
  });
  const client = clients.create('stream-client');
  apiKey = credentials.create(client.id, 'primary').apiKey;
  extensions.upsert('openai', '1.0.0', true);
  const target = createTarget(targets);
  grants.grant(client.id, 'openai', target.id);
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.useRealTimers();
  await app.close();
  db.close();
});

describe('OpenAI SSE streaming', () => {
  it('streams Chat role and text before the provider terminal, then stop and DONE in wire order', async () => {
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'private-native-session' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'completed' },
    ], 2);

    const stream = await openStream('/v1/chat/completions', {
      model: 'model', messages: [{ role: 'user', content: 'private prompt' }], stream: true,
    });
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers['content-type']).toContain('text/event-stream');
    await stream.firstFrame;
    await vi.waitFor(() => expect(stream.chunks.join('')).toContain('Hello'));
    expect(stream.chunks.join('')).not.toContain('[DONE]');

    invocations.current.release.resolve();
    await stream.ended;
    const frames = dataFrames(stream.chunks.join(''));
    expect(frames.map((frame) => typeof frame === 'string'
      ? frame
      : ((frame.choices as Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }>)[0]
          ?.delta.role ?? (frame.choices as Array<{ delta: { content?: string }; finish_reason: string | null }>)[0]
          ?.delta.content ?? (frame.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason)))
      .toEqual(['assistant', 'Hello', ' world', 'stop', '[DONE]']);
    expect(stream.chunks.join('')).not.toContain('private-native-session');
    expect(stream.chunks.join('')).not.toContain('private prompt');
  });

  it('streams Responses lifecycle and deltas with stable IDs and indices', async () => {
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'private-native-session' },
      { type: 'text_delta', delta: 'Hello' },
      { type: 'text_delta', delta: ' world' },
      { type: 'completed' },
    ], 2);

    const stream = await openStream('/v1/responses', {
      model: 'model', input: 'private prompt', store: false, stream: true,
    });
    await stream.firstFrame;
    await vi.waitFor(() => expect(stream.chunks.join('')).toContain('response.output_text.delta'));
    expect(stream.chunks.join('')).not.toContain('response.completed');
    invocations.current.release.resolve();
    await stream.ended;

    const frames = dataFrames(stream.chunks.join('')) as Array<Record<string, unknown>>;
    expect(frames.map((frame) => frame.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.completed',
    ]);
    const deltas = frames.filter((frame) => frame.type === 'response.output_text.delta');
    expect(deltas.map((frame) => frame.delta)).toEqual(['Hello', ' world']);
    expect(deltas.map((frame) => [frame.item_id, frame.output_index, frame.content_index]))
      .toEqual([[deltas[0]!.item_id, 0, 0], [deltas[0]!.item_id, 0, 0]]);
    expect(JSON.stringify(frames)).not.toContain('private-native-session');
    expect(JSON.stringify(frames)).not.toContain('private prompt');
  });

  it.each([
    ['/v1/chat/completions', { model: 'model', messages: [{ role: 'user', content: 'stop' }], stream: true }],
    ['/v1/responses', { model: 'model', input: 'stop', store: false, stream: true }],
  ])('returns the provider iterator when the client disconnects from %s', async (path, body) => {
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'native' },
      { type: 'text_delta', delta: 'first' },
      { type: 'text_delta', delta: 'late' },
      { type: 'completed' },
    ], 2);
    const stream = await openStream(path, body);
    await stream.firstFrame;
    stream.destroy();
    await expect(invocations.current.returned.promise).resolves.toBeUndefined();
  });

  it('writes a 15-second heartbeat comment while a provider is idle', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'native' },
      { type: 'text_delta', delta: 'late' },
      { type: 'completed' },
    ], 1);
    const stream = await openStream('/v1/chat/completions', {
      model: 'model', messages: [{ role: 'user', content: 'wait' }], stream: true,
    });
    await stream.firstFrame;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(stream.chunks.join('')).toContain(': heartbeat\n\n'));
    stream.destroy();
    await invocations.current.returned.promise;
  });

  it('does not hang on backpressure after the socket closes', async () => {
    invocations.current = new ControlledEvents([
      { type: 'text_delta', delta: 'x'.repeat(8 * 1024 * 1024) },
      { type: 'completed' },
    ]);
    const stream = await openStream('/v1/chat/completions', {
      model: 'model', messages: [{ role: 'user', content: 'large' }], stream: true,
    });
    stream.response.pause();
    stream.destroy();
    await expect(invocations.current.returned.promise).resolves.toBeUndefined();
  });

  it('emits a safe error instead of response.completed when completeContinuation fails', async () => {
    sessions.create({
      responseId: 'resp_parent',
      targetId: 'model',
      nativeSessionId: 'native-parent',
      workspacePath: '/responses/resp_parent',
    });
    vi.spyOn(sessions, 'completeContinuation').mockImplementation(() => {
      throw new Error('private continuation failure');
    });
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'native-child' },
      { type: 'text_delta', delta: 'answer' },
      { type: 'completed' },
    ]);

    const stream = await openStream('/v1/responses', {
      model: 'model', input: 'continue', previous_response_id: 'resp_parent', stream: true,
    });
    await stream.ended;
    const wire = stream.chunks.join('');
    expect(wire).toContain('"type":"error"');
    expect(wire).not.toContain('response.output_text.done');
    expect(wire).not.toContain('response.completed');
    expect(wire).not.toContain('private continuation failure');
  });

  it('emits a safe error instead of response.completed when workspace release fails', async () => {
    workspaces.releaseError = new Error('private workspace release failure');
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'native' },
      { type: 'text_delta', delta: 'answer' },
      { type: 'completed' },
    ]);

    const stream = await openStream('/v1/responses', {
      model: 'model', input: 'release', stream: true,
    });
    await stream.ended;
    const wire = stream.chunks.join('');
    expect(workspaces.releaseCalls).toBe(1);
    expect(wire).toContain('"code":"workspace_error"');
    expect(wire).not.toContain('response.output_text.done');
    expect(wire).not.toContain('response.completed');
    expect(wire).not.toContain('private workspace release failure');
  });

  it('emits a safe error instead of response.completed when owner idempotency completion fails', async () => {
    vi.spyOn(idempotency, 'complete').mockImplementation(() => {
      throw new Error('private idempotency failure');
    });
    invocations.current = new ControlledEvents([
      { type: 'session_started', nativeSessionId: 'native' },
      { type: 'text_delta', delta: 'answer' },
      { type: 'completed' },
    ]);

    const stream = await openStream('/v1/responses', {
      model: 'model', input: 'idempotent', stream: true,
    }, { 'idempotency-key': 'responses-finalization' });
    await stream.ended;
    const wire = stream.chunks.join('');
    expect(wire).toContain('"type":"error"');
    expect(wire).not.toContain('response.output_text.done');
    expect(wire).not.toContain('response.completed');
    expect(wire).not.toContain('private idempotency failure');
    expect(invocations.requests).toHaveLength(1);
  });

  it('completes Chat owner idempotency before finish and emits only a safe error on failure', async () => {
    vi.spyOn(idempotency, 'complete').mockImplementation(() => {
      throw new Error('private chat idempotency failure');
    });
    invocations.current = new ControlledEvents([
      { type: 'text_delta', delta: 'answer' },
      { type: 'completed' },
    ]);

    const stream = await openStream('/v1/chat/completions', {
      model: 'model', messages: [{ role: 'user', content: 'idempotent' }], stream: true,
    }, { 'idempotency-key': 'chat-finalization' });
    await stream.ended;
    const wire = stream.chunks.join('');
    expect(wire).toContain('"code":"internal_error"');
    expect(wire).not.toContain('"finish_reason":"stop"');
    expect(wire).not.toContain('data: [DONE]');
    expect(wire).not.toContain('private chat idempotency failure');
    expect(invocations.requests).toHaveLength(1);
  });
});
