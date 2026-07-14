import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGatewayConfig } from '../../../src/config/config.js';
import { ClientRepository } from '../../../src/control-plane/clients.js';
import { CredentialService } from '../../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../../src/control-plane/db.js';
import { ExtensionRepository } from '../../../src/control-plane/extensions.js';
import { GrantRepository } from '../../../src/control-plane/grants.js';
import { ResponseSessionRepository } from '../../../src/control-plane/response-sessions.js';
import { RunRepository } from '../../../src/control-plane/runs.js';
import { TargetRepository } from '../../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../../src/control-plane/types.js';
import type { InvocationRequest } from '../../../src/provider-runtime/invocation-service.js';
import type { ProviderEvent } from '../../../src/provider-runtime/types.js';
import type { WorkspaceLease } from '../../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../../src/server/app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const VERIFIED_CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

class FakeInvocationService {
  readonly requests: InvocationRequest[] = [];
  events: Array<ProviderEvent | Record<string, unknown>> = [
    { type: 'session_started', nativeSessionId: 'native-session' },
    { type: 'text_delta', delta: 'Hello' },
    { type: 'text_delta', delta: ' world' },
    { type: 'completed' },
  ];
  error: unknown;
  invokeError: unknown;
  onInvoke: ((request: InvocationRequest) => void) | undefined;

  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    this.onInvoke?.(request);
    if (this.invokeError !== undefined) throw this.invokeError;
    const events = this.events;
    const error = this.error;
    return (async function* () {
      for (const event of events) yield event as ProviderEvent;
      if (error !== undefined) throw error;
    })();
  }
}

class FakeResponseWorkspaces {
  readonly created: Array<{ targetId: string; responseId: string; path: string }> = [];
  readonly released: string[] = [];
  readonly cleaned: string[][] = [];

  async createResponse(target: InvocationTarget, responseId: string): Promise<WorkspaceLease> {
    const path = `/canonical/responses/${responseId}`;
    this.created.push({ targetId: target.id, responseId, path });
    let released = false;
    return {
      path,
      release: async () => {
        if (released) return;
        released = true;
        this.released.push(path);
      },
    };
  }

  async cleanupExpired(paths: string[]): Promise<void> {
    this.cleaned.push(paths);
  }
}

let app: FastifyInstance;
let db: GatewayDb;
let clients: ClientRepository;
let credentials: CredentialService;
let extensions: ExtensionRepository;
let grants: GrantRepository;
let runs: RunRepository;
let targets: TargetRepository;
let sessions: ResponseSessionRepository;
let invocations: FakeInvocationService;
let workspaces: FakeResponseWorkspaces;
let apiKey: string;
let clientId: string;

function createEnabledTarget(id = 'responses-model', aliases: string[] = ['responses-alias']): InvocationTarget {
  targets.create({
    id,
    aliases,
    cli: 'codex',
    nativeModel: 'gpt-5.6',
    reasoningEffort: 'max',
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 300_000,
    runTimeoutMs: null,
  });
  targets.setCapability(id, {
    version: '1.0.0',
    verifiedAt: '2026-07-10T12:00:00.000Z',
    capabilities: VERIFIED_CAPABILITIES,
  });
  return targets.update(id, { enabled: true });
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'responses-model', input: 'Say hello', ...overrides };
}

async function respond(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${apiKey}` },
    payload: body,
  });
}

function expectOpenAIError(
  response: { statusCode: number; json: () => unknown },
  status: number,
  code: string,
  param: string | null = null,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({
    error: {
      message: expect.any(String),
      type: expect.any(String),
      param,
      code,
    },
  });
}

function createStoredResponse(
  responseId: string,
  targetId = 'responses-model',
  now?: string,
): void {
  sessions.create({
    responseId,
    targetId,
    nativeSessionId: `native-${responseId}`,
    workspacePath: `/canonical/responses/${responseId}`,
    now,
  });
}

beforeEach(async () => {
  db = openGatewayDb(':memory:');
  clients = new ClientRepository(db);
  credentials = new CredentialService(db, Buffer.alloc(32, 5));
  extensions = new ExtensionRepository(db);
  grants = new GrantRepository(db);
  runs = new RunRepository(db);
  targets = new TargetRepository(db);
  sessions = new ResponseSessionRepository(db);
  invocations = new FakeInvocationService();
  workspaces = new FakeResponseWorkspaces();
  app = buildGatewayApp({
    config: resolveGatewayConfig({ baseDir: '/tmp/asq-gateway-responses-test' }),
    db,
    clients,
    credentials,
    extensions,
    grants,
    targets,
    runs,
    adminAuth: new AdminAuthService(db, Buffer.alloc(32, 7)),
    invocationService: invocations,
    responseSessions: sessions,
    responseWorkspaces: workspaces,
  });
  const client = clients.create('responses-client');
  clientId = client.id;
  apiKey = credentials.create(client.id, 'primary').apiKey;
  extensions.upsert('openai', '1.0.0', true);
  const target = createEnabledTarget();
  grants.grant(client.id, 'openai', target.id);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
});

describe('POST /v1/responses', () => {
  it('records a rejected request as a failed Responses run', async () => {
    const response = await respond(requestBody({
      input: 'private response input must not be stored',
      extra: true,
    }));

    expectOpenAIError(response, 400, 'invalid_request');
    expect(runs.list()).toEqual([expect.objectContaining({
      clientId,
      extensionId: 'openai',
      targetId: 'responses-model',
      endpoint: 'responses',
      status: 'failed',
      errorCode: 'invalid_request',
      responseId: null,
    })]);
    expect(JSON.stringify(runs.list())).not.toContain('private response input');
  });

  it('starts a stored response from string input and returns the exact text response shape', async () => {
    const response = await respond(requestBody({ model: 'responses-alias' }));

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.stringMatching(/^resp_[0-9a-f-]{36}$/),
      object: 'response',
      status: 'completed',
      model: 'responses-alias',
      output: [{
        id: expect.stringMatching(/^msg_[0-9a-f-]{36}$/),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello world', annotations: [] }],
      }],
      output_text: 'Hello world',
    });
    const responseId = body.id as string;
    expect(invocations.requests).toEqual([{
      runId: expect.stringMatching(/^run_/),
      clientId,
      extensionId: 'openai',
      targetId: 'responses-model',
      endpoint: 'responses',
      responseId,
      input: [{ role: 'user', content: 'Say hello' }],
      sessionMode: 'persistent',
      workspacePath: `/canonical/responses/${responseId}`,
    }]);
    expect(sessions.get(responseId)).toEqual(expect.objectContaining({
      responseId,
      targetId: 'responses-model',
      nativeSessionId: 'native-session',
      workspacePath: `/canonical/responses/${responseId}`,
      stored: true,
      state: 'open',
    }));
    expect(workspaces.released).toEqual([`/canonical/responses/${responseId}`]);
    expect(workspaces.cleaned).toEqual([]);
  });

  it('normalizes the strict text message-array subset', async () => {
    const response = await respond(requestBody({
      input: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ],
    }));

    expect(response.statusCode).toBe(200);
    expect(invocations.requests[0]?.input).toEqual([
      { role: 'system', content: 'Be concise' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
  });

  it.each([
    ['unknown request field', requestBody({ extra: true })],
    ['cwd', requestBody({ cwd: '/tmp/caller' })],
    ['workspace', requestBody({ workspace: '/tmp/caller' })],
    ['native session', requestBody({ native_session_id: 'native-private' })],
    ['empty messages', requestBody({ input: [] })],
    ['unknown message field', requestBody({ input: [{ role: 'user', content: 'Hi', extra: true }] })],
    ['unsupported role', requestBody({ input: [{ role: 'tool', content: 'Hi' }] })],
    ['multimodal content', requestBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }] })],
  ])('rejects %s before scheduling', async (_name, body) => {
    const response = await respond(body);
    expectOpenAIError(response, 400, 'invalid_request');
    expect(invocations.requests).toHaveLength(0);
  });

  it('dispatches streaming and rejects store:false continuation', async () => {
    const streaming = await respond(requestBody({ stream: true }));
    expect(streaming.statusCode).toBe(200);
    expect(streaming.headers['content-type']).toContain('text/event-stream');
    expect(streaming.body).toContain('response.completed');

    createStoredResponse('resp_parent');
    const ephemeralResume = await respond(requestBody({
      previous_response_id: 'resp_parent',
      store: false,
    }));
    expectOpenAIError(ephemeralResume, 400, 'invalid_request');
    expect(invocations.requests).toHaveLength(1);
  });

  it('resolves unknown and unavailable models before response state', async () => {
    const missing = await respond(requestBody({ model: 'missing-model' }));
    expectOpenAIError(missing, 404, 'model_not_found');

    createEnabledTarget('ungranted', []);
    createEnabledTarget('disabled', []);
    createEnabledTarget('incompatible', []);
    targets.update('disabled', { enabled: false });
    db.prepare('UPDATE invocation_targets SET capability_verified_at = NULL WHERE id = ?').run('incompatible');
    grants.grant(clientId, 'openai', 'disabled');
    grants.grant(clientId, 'openai', 'incompatible');

    for (const model of ['ungranted', 'disabled', 'incompatible']) {
      const response = await respond(requestBody({ model }));
      expectOpenAIError(response, 403, 'model_not_allowed');
    }
    expect(invocations.requests).toHaveLength(0);
  });

  it('returns tools_not_supported for targets without a structured tool bridge', async () => {
    const target = targets.create({
      id: 'text-only-model',
      aliases: [],
      cli: 'text-only-provider',
      nativeModel: 'text-only',
      reasoningEffort: null,
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'none',
      maxConcurrency: 1,
      maxQueue: 8,
      queueTimeoutMs: 300_000,
      runTimeoutMs: null,
    });
    targets.setCapability(target.id, {
      version: '1.0.0',
      verifiedAt: '2026-07-10T12:00:00.000Z',
      capabilities: {
        ...VERIFIED_CAPABILITIES,
        toolBridge: 'none',
        effortSelection: false,
      },
    });
    targets.update(target.id, { enabled: true });
    grants.grant(clientId, 'openai', target.id);

    const response = await respond(requestBody({
      model: target.id,
      tools: [{ type: 'function', name: 'read_file' }],
      tool_choice: 'auto',
    }));

    expectOpenAIError(response, 400, 'tools_not_supported', 'tools');
    expect(invocations.requests).toHaveLength(0);
  });

  it('acquires the parent before scheduling and resumes once with its native session and workspace', async () => {
    createStoredResponse('resp_parent');
    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-child' },
      { type: 'text_delta', delta: 'continued' },
      { type: 'completed' },
    ];
    invocations.onInvoke = () => {
      expect(sessions.get('resp_parent')?.state).toBe('continuing');
    };

    const response = await respond(requestBody({ previous_response_id: 'resp_parent' }));

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string };
    expect(invocations.requests).toEqual([expect.objectContaining({
      responseId: body.id,
      sessionMode: 'persistent',
      nativeSessionId: 'native-resp_parent',
      workspacePath: '/canonical/responses/resp_parent',
    })]);
    expect(workspaces.created).toHaveLength(0);
    expect(sessions.get('resp_parent')).toEqual(expect.objectContaining({
      state: 'continued',
      childResponseId: body.id,
    }));
    expect(sessions.get(body.id)).toEqual(expect.objectContaining({
      parentResponseId: 'resp_parent',
      nativeSessionId: 'native-child',
      workspacePath: '/canonical/responses/resp_parent',
      state: 'open',
    }));
  });

  it('maps wrong-target, expired, concurrent, continued, and terminal chains without scheduling', async () => {
    const other = createEnabledTarget('other-model', []);
    grants.grant(clientId, 'openai', other.id);
    createStoredResponse('resp_wrong_target', other.id);
    createStoredResponse('resp_expired', 'responses-model', '2020-01-01T00:00:00.000Z');
    sessions.expire('2020-02-01T00:00:00.000Z');
    createStoredResponse('resp_concurrent');
    sessions.acquireContinuation('resp_concurrent', 'responses-model');
    createStoredResponse('resp_continued');
    sessions.acquireContinuation('resp_continued', 'responses-model');
    sessions.completeContinuation({ parentResponseId: 'resp_continued', childResponseId: 'resp_child' });
    createStoredResponse('resp_terminal');
    sessions.acquireContinuation('resp_terminal', 'responses-model');
    sessions.failTerminal('resp_terminal');

    const cases: Array<[string, number, string]> = [
      ['resp_missing', 404, 'response_not_found'],
      ['resp_wrong_target', 400, 'response_target_mismatch'],
      ['resp_expired', 404, 'response_expired'],
      ['resp_concurrent', 409, 'response_in_progress'],
      ['resp_continued', 409, 'response_already_continued'],
      ['resp_terminal', 409, 'response_terminal_failure'],
    ];
    for (const [previousResponseId, status, code] of cases) {
      const response = await respond(requestBody({ previous_response_id: previousResponseId }));
      expectOpenAIError(response, status, code);
    }
    expect(invocations.requests).toHaveLength(0);
  });

  it('releases a continuation when invocation fails before native resume starts', async () => {
    createStoredResponse('resp_parent');
    invocations.invokeError = new Error('private scheduling failure');

    const response = await respond(requestBody({ previous_response_id: 'resp_parent' }));

    expectOpenAIError(response, 502, 'provider_error');
    expect(sessions.get('resp_parent')?.state).toBe('open');
    expect(JSON.stringify(response.json())).not.toContain('private');
  });

  it('terminalizes the chain when a continuation fails after native state advances', async () => {
    createStoredResponse('resp_parent');
    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-resp_parent' },
      { type: 'failed', code: 'private_code', message: 'private message', nativeStateAdvanced: true },
    ];

    const response = await respond(requestBody({ previous_response_id: 'resp_parent' }));

    expectOpenAIError(response, 502, 'provider_error');
    expect(sessions.get('resp_parent')?.state).toBe('terminal_failure');
    expect(JSON.stringify(response.json())).not.toContain('private');
  });

  it('uses ephemeral mode for store:false and leaves a metadata-free tombstone', async () => {
    const response = await respond(requestBody({ store: false }));

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string };
    expect(invocations.requests).toEqual([expect.objectContaining({
      responseId: body.id,
      sessionMode: 'ephemeral',
    })]);
    expect(invocations.requests[0]).not.toHaveProperty('workspacePath');
    expect(invocations.requests[0]).not.toHaveProperty('nativeSessionId');
    expect(workspaces.created).toHaveLength(0);
    expect(sessions.get(body.id)).toEqual(expect.objectContaining({
      stored: false,
      state: 'not_stored',
      nativeSessionId: null,
      workspacePath: null,
    }));
  });

  it('refreshes the full chain TTL by 30 days on successful continuation', async () => {
    createStoredResponse('resp_root', 'responses-model', '2026-07-10T00:00:00.000Z');
    sessions.acquireContinuation('resp_root', 'responses-model', '2026-07-10T01:00:00.000Z');
    sessions.completeContinuation({
      parentResponseId: 'resp_root',
      childResponseId: 'resp_parent',
      nativeSessionId: 'native-resp_parent',
      workspacePath: '/canonical/responses/resp_root',
      now: '2026-07-10T01:00:00.000Z',
    });
    const before = Date.now();

    const response = await respond(requestBody({ previous_response_id: 'resp_parent' }));

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string };
    const expiries = ['resp_root', 'resp_parent', body.id].map((id) => sessions.get(id)?.expiresAt);
    expect(new Set(expiries).size).toBe(1);
    const expiresAt = Date.parse(expiries[0]!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
  });

  it.each([
    ['structured delta', [
      { type: 'session_started', nativeSessionId: 'native-session' },
      { type: 'structured_delta', delta: '{"private":true}' },
      { type: 'completed' },
    ]],
    ['missing terminal', [
      { type: 'session_started', nativeSessionId: 'native-session' },
      { type: 'text_delta', delta: 'partial' },
    ]],
    ['duplicate terminal', [
      { type: 'session_started', nativeSessionId: 'native-session' },
      { type: 'completed' },
      { type: 'completed' },
    ]],
  ])('rejects provider protocol violation: %s', async (_name, events) => {
    invocations.events = events;
    const response = await respond(requestBody());
    expectOpenAIError(response, 502, 'adapter_protocol_error');
  });

  it('cleans an abandoned stored workspace after failure before session_started', async () => {
    invocations.events = [{
      type: 'failed',
      code: 'provider_spawn_failed',
      message: 'private',
      nativeStateAdvanced: false,
    }];

    const response = await respond(requestBody());

    expectOpenAIError(response, 502, 'provider_error');
    expect(workspaces.created).toHaveLength(1);
    const [{ responseId, path }] = workspaces.created;
    expect(sessions.get(responseId)).toBeUndefined();
    expect(workspaces.released).toEqual([path]);
    expect(workspaces.cleaned).toEqual([[path]]);
  });

  it('does not persist prompts, completions, or raw provider events', async () => {
    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-private' },
      { type: 'text_delta', delta: 'private-completion' },
      { type: 'completed' },
    ];
    const response = await respond(requestBody({ input: 'private-prompt' }));
    expect(response.statusCode).toBe(200);

    const tables = db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    const persisted = JSON.stringify(tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()));
    expect(persisted).not.toContain('private-prompt');
    expect(persisted).not.toContain('private-completion');
  });

  it('returns function-call items and validates complete continuation outputs', async () => {
    const tools = [{
      type: 'function',
      name: 'weather',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }];
    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-tools' },
      { type: 'structured_delta', delta: '{"type":"tool_calls","tool_calls":[{"name":"weather","arguments":{"city":"Boston"}}]}' },
      { type: 'completed' },
    ];
    const first = await respond(requestBody({ tools, tool_choice: 'required' }));
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      id: string;
      output: Array<{ type: string; call_id: string; name: string; arguments: string }>;
    };
    expect(firstBody.output).toEqual([expect.objectContaining({
      type: 'function_call',
      call_id: expect.stringMatching(/^call_[0-9a-f-]{36}$/),
      name: 'weather',
      arguments: '{"city":"Boston"}',
    })]);
    expect(invocations.requests[0]).toHaveProperty('outputSchema');
    expect(invocations.requests[0]).not.toHaveProperty('tools');

    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-tools-continued' },
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"Sunny"}' },
      { type: 'completed' },
    ];
    const continued = await respond(requestBody({
      previous_response_id: firstBody.id,
      input: [{
        type: 'function_call_output',
        call_id: firstBody.output[0]!.call_id,
        output: '72 F and sunny',
      }],
      tools,
    }));
    expect(continued.statusCode).toBe(200);
    expect(invocations.requests[1]!.input).toEqual([{
      role: 'tool',
      toolCallId: firstBody.output[0]!.call_id,
      content: '72 F and sunny',
    }]);

    const unknown = await respond(requestBody({
      previous_response_id: firstBody.id,
      input: [{ type: 'function_call_output', call_id: 'call_unknown', output: 'x' }],
      tools,
    }));
    expectOpenAIError(unknown, 400, 'invalid_request');
    expect(invocations.requests).toHaveLength(2);
  });

  it('streams Responses function-call lifecycle events after validated decode', async () => {
    invocations.events = [
      { type: 'session_started', nativeSessionId: 'native-stream-tools' },
      { type: 'structured_delta', delta: '{"type":"tool_calls","tool_calls":[{"name":"weather","arguments":{}}]}' },
      { type: 'completed' },
    ];
    const response = await respond(requestBody({
      stream: true,
      tools: [{ type: 'function', name: 'weather' }],
    }));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"response.output_item.added"');
    expect(response.body).toContain('"type":"response.function_call_arguments.done"');
    expect(response.body).toContain('"type":"response.output_item.done"');
    expect(response.body).toContain('"type":"response.completed"');
  });
});
