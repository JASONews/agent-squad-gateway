import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGatewayConfig } from '../../../src/config/config.js';
import { ClientRepository } from '../../../src/control-plane/clients.js';
import { CredentialService } from '../../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../../src/control-plane/db.js';
import { ExtensionRepository } from '../../../src/control-plane/extensions.js';
import { GrantRepository } from '../../../src/control-plane/grants.js';
import { RunRepository } from '../../../src/control-plane/runs.js';
import { TargetRepository } from '../../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../../src/control-plane/types.js';
import type { InvocationRequest } from '../../../src/provider-runtime/invocation-service.js';
import type { ProviderEvent } from '../../../src/provider-runtime/types.js';
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

class FakeInvocationService {
  readonly requests: InvocationRequest[] = [];
  events: Array<ProviderEvent | Record<string, unknown>> = [
    { type: 'text_delta', delta: 'Hello' },
    { type: 'text_delta', delta: ' world' },
    { type: 'completed' },
  ];
  error: unknown;

  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    const events = this.events;
    const error = this.error;
    return (async function* () {
      for (const event of events) yield event as ProviderEvent;
      if (error !== undefined) throw error;
    })();
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
let invocations: FakeInvocationService;
let apiKey: string;
let clientId: string;

function createEnabledTarget(id = 'chat-model', aliases: string[] = ['chat-alias']): InvocationTarget {
  const target = targets.create({
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
  return {
    model: 'chat-model',
    messages: [{ role: 'user', content: 'Say hello' }],
    ...overrides,
  };
}

async function chat(body: Record<string, unknown>, authorization = `Bearer ${apiKey}`) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization },
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

beforeEach(async () => {
  db = openGatewayDb(':memory:');
  clients = new ClientRepository(db);
  credentials = new CredentialService(db, Buffer.alloc(32, 5));
  extensions = new ExtensionRepository(db);
  grants = new GrantRepository(db);
  runs = new RunRepository(db);
  targets = new TargetRepository(db);
  invocations = new FakeInvocationService();
  app = buildGatewayApp({
    config: resolveGatewayConfig({ baseDir: '/tmp/asq-gateway-chat-test' }),
    db,
    clients,
    credentials,
    extensions,
    grants,
    targets,
    runs,
    adminAuth: new AdminAuthService(db, Buffer.alloc(32, 7)),
    invocationService: invocations,
  });
  const client = clients.create('chat-client');
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

describe('POST /v1/chat/completions', () => {
  it('normalizes all supported messages and returns one aggregated assistant choice', async () => {
    invocations.events = [
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"Hello world"}' },
      { type: 'completed' },
    ];
    const response = await chat(requestBody({
      model: 'chat-alias',
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Check weather' },
        { role: 'assistant', content: 'I will check.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Boston"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
      tool_choice: 'auto',
    }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: expect.stringMatching(/^chatcmpl_/),
      object: 'chat.completion',
      created: expect.any(Number),
      model: 'chat-alias',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello world' },
        finish_reason: 'stop',
      }],
    });
    expect(invocations.requests).toEqual([{
      runId: expect.stringMatching(/^run_/),
      clientId,
      extensionId: 'openai',
      targetId: 'chat-model',
      endpoint: 'chat.completions',
      input: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Check weather' },
        { role: 'assistant', content: 'I will check.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call_1', name: 'weather', arguments: { city: 'Boston' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: 'Sunny' },
      ],
      sessionMode: 'ephemeral',
      outputSchema: expect.any(Object),
    }]);
  });

  it('requires Task 6 bearer authentication before invoking', async () => {
    const response = await chat(requestBody(), 'Bearer invalid');
    expectOpenAIError(response, 401, 'invalid_api_key');
    expect(invocations.requests).toHaveLength(0);
    expect(runs.list()).toEqual([]);
  });

  it('records a rejected authenticated request without persisting its prompt', async () => {
    const response = await chat(requestBody({
      messages: [{ role: 'user', content: 'private prompt must not be stored' }],
      extra: true,
    }));

    expectOpenAIError(response, 400, 'invalid_request');
    expect(runs.list()).toEqual([expect.objectContaining({
      clientId,
      extensionId: 'openai',
      targetId: 'chat-model',
      endpoint: 'chat.completions',
      status: 'failed',
      errorCode: 'invalid_request',
      startedAt: null,
      latencyMs: null,
    })]);
    expect(JSON.stringify(runs.list())).not.toContain('private prompt');
  });

  it('accepts validated LiteLLM generation hints without forwarding provider controls', async () => {
    const response = await chat(requestBody({
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 64,
      max_completion_tokens: 64,
      n: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      seed: 7,
      stop: ['END'],
      response_format: { type: 'text' },
      store: false,
      user: 'litellm-client',
    }));

    expect(response.statusCode).toBe(200);
    expect(invocations.requests).toHaveLength(1);
    expect(invocations.requests[0]).toEqual(expect.objectContaining({
      targetId: 'chat-model',
      endpoint: 'chat.completions',
      sessionMode: 'ephemeral',
    }));
    for (const key of ['temperature', 'top_p', 'max_tokens', 'seed', 'stop']) {
      expect(invocations.requests[0]).not.toHaveProperty(key);
    }
  });

  it('accepts and concatenates OpenCode text content parts forwarded by LiteLLM', async () => {
    const response = await chat(requestBody({
      messages: [
        { role: 'system', content: 'Be concise.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: '\nContext from OpenCode.' },
          ],
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      top_p: 0.95,
      max_tokens: 32_000,
    }));

    expect(response.statusCode).toBe(200);
    expect(invocations.requests[0]?.input).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello\nContext from OpenCode.' },
    ]);
  });

  it.each([
    ['unknown request', requestBody({ extra: true })],
    ['request', requestBody({ cwd: '/tmp/caller' })],
    ['workspace', requestBody({ workspace: '/tmp/caller' })],
    ['multiple choices', requestBody({ n: 2 })],
    ['JSON response format', requestBody({ response_format: { type: 'json_object' } })],
    ['stored chat', requestBody({ store: true })],
    ['stream options', requestBody({ stream_options: { include_usage: true, extra: true } })],
    ['message', requestBody({ messages: [{ role: 'user', content: 'hello', extra: true }] })],
    ['multimodal content', requestBody({ messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }],
    }] })],
    ['tool call', requestBody({ messages: [{
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}', extra: true } }],
    }] })],
    ['tool', requestBody({ tools: [{ type: 'function', function: { name: 'f' }, extra: true }] })],
    ['tool function', requestBody({ tools: [{ type: 'function', function: { name: 'f', extra: true } }] })],
    ['tool choice', requestBody({ tool_choice: { type: 'function', function: { name: 'f' }, extra: true } })],
  ])('rejects unknown or unsupported %s fields and shapes', async (_name, body) => {
    const response = await chat(body);
    expectOpenAIError(response, 400, 'invalid_request');
    expect(invocations.requests).toHaveLength(0);
  });

  it('dispatches stream true with LiteLLM usage options to the SSE writer', async () => {
    const response = await chat(requestBody({
      stream: true,
      stream_options: { include_usage: true },
    }));
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: [DONE]\n\n');
    expect(invocations.requests).toHaveLength(1);
  });

  it('returns 404 for an unknown model or alias', async () => {
    const response = await chat(requestBody({ model: 'missing-model' }));
    expectOpenAIError(response, 404, 'model_not_found');
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

    const response = await chat(requestBody({
      model: target.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Use a tool.' }] }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
    }));

    expectOpenAIError(response, 400, 'tools_not_supported', 'tools');
    expect(invocations.requests).toHaveLength(0);
  });

  it('returns 403 for known ungranted, disabled, and incompatible targets', async () => {
    const cases = [
      createEnabledTarget('ungranted', []),
      createEnabledTarget('disabled', []),
      createEnabledTarget('incompatible', []),
    ];
    targets.update('disabled', { enabled: false });
    db.prepare('UPDATE invocation_targets SET capability_verified_at = NULL WHERE id = ?').run('incompatible');
    grants.grant(clientId, 'openai', 'disabled');
    grants.grant(clientId, 'openai', 'incompatible');

    for (const target of cases) {
      const response = await chat(requestBody({ model: target.id }));
      expectOpenAIError(response, 403, 'model_not_allowed');
    }
    expect(invocations.requests).toHaveLength(0);
  });

  it('maps provider failed and cancelled terminals to safe envelopes', async () => {
    invocations.events = [{
      type: 'failed',
      code: 'secret_provider_code',
      message: 'secret provider message',
      nativeStateAdvanced: true,
    }];
    const failed = await chat(requestBody());
    expectOpenAIError(failed, 502, 'provider_error');
    expect(JSON.stringify(failed.json())).not.toContain('secret');

    invocations.events = [{ type: 'cancelled' }];
    const cancelled = await chat(requestBody());
    expectOpenAIError(cancelled, 500, 'request_cancelled');
  });

  it('records a provider failure exactly once', async () => {
    invocations.events = [{
      type: 'failed',
      code: 'private_provider_code',
      message: 'private provider message',
      nativeStateAdvanced: false,
    }];

    const response = await chat(requestBody());

    expectOpenAIError(response, 502, 'provider_error');
    expect(runs.list()).toEqual([expect.objectContaining({
      targetId: 'chat-model',
      status: 'failed',
      errorCode: 'provider_error',
    })]);
  });

  it('maps InvocationService protocol failures without exposing provider details', async () => {
    invocations.events = [{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'private malformed event details',
      nativeStateAdvanced: false,
    }];
    const response = await chat(requestBody());
    expectOpenAIError(response, 502, 'adapter_protocol_error');
    expect(JSON.stringify(response.json())).not.toContain('private');
  });

  it.each([
    ['missing terminal', [{ type: 'text_delta', delta: 'partial' }]],
    ['duplicate terminal', [{ type: 'completed' }, { type: 'completed' }]],
    ['event after terminal', [{ type: 'completed' }, { type: 'text_delta', delta: 'late' }]],
    ['unknown event', [{ type: 'mystery', payload: 'private' }]],
  ])('rejects malformed provider protocol: %s', async (_name, events) => {
    invocations.events = events;
    const response = await chat(requestBody());
    expectOpenAIError(response, 502, 'adapter_protocol_error');
  });

  it('rejects structured deltas without tools and requires valid envelopes when tools are supplied', async () => {
    invocations.events = [{ type: 'structured_delta', delta: '{"private":true}' }, { type: 'completed' }];
    const rejected = await chat(requestBody());
    expectOpenAIError(rejected, 502, 'adapter_protocol_error');
    const rejectedWithEmptyTools = await chat(requestBody({ tools: [] }));
    expectOpenAIError(rejectedWithEmptyTools, 502, 'adapter_protocol_error');

    invocations.events = [
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"ok"}' },
      { type: 'completed' },
    ];
    const accepted = await chat(requestBody({
      tools: [{ type: 'function', function: { name: 'f' } }],
    }));
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    });
  });

  it('starts a fresh ephemeral invocation for every Chat call', async () => {
    await chat(requestBody());
    await chat(requestBody());

    expect(invocations.requests).toHaveLength(2);
    for (const request of invocations.requests) {
      expect(request.sessionMode).toBe('ephemeral');
      expect(request.endpoint).toBe('chat.completions');
      expect(request).not.toHaveProperty('responseId');
      expect(request).not.toHaveProperty('nativeSessionId');
      expect(request).not.toHaveProperty('workspacePath');
    }
  });

  it('does not persist prompt, completion, or tool payloads in SQLite', async () => {
    invocations.events = [
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"private-completion"}' },
      { type: 'completed' },
    ];
    const response = await chat(requestBody({
      messages: [{ role: 'user', content: 'private-prompt' }],
      tools: [{
        type: 'function',
        function: { name: 'private-tool', parameters: { secret: 'private-tool-payload' } },
      }],
    }));
    expect(response.statusCode).toBe(200);

    const tables = db.prepare<[], { name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all();
    const rows = tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all());
    const persisted = JSON.stringify(rows);
    expect(persisted).not.toContain('private-prompt');
    expect(persisted).not.toContain('private-completion');
    expect(persisted).not.toContain('private-tool');
    expect(persisted).not.toContain('private-tool-payload');
  });

  it('maps invocation iteration failures without exposing their message', async () => {
    invocations.events = [];
    invocations.error = new Error('private iterator failure');
    const response = await chat(requestBody());
    expectOpenAIError(response, 502, 'provider_error');
    expect(JSON.stringify(response.json())).not.toContain('private');
  });

  it('translates validated structured calls and passes only outputSchema to the provider', async () => {
    invocations.events = [
      { type: 'structured_delta', delta: '{"type":"tool_calls","tool_calls":[' },
      { type: 'structured_delta', delta: '{"name":"weather","arguments":{"city":"Boston"}}]}' },
      { type: 'completed' },
    ];
    const response = await chat(requestBody({
      tools: [{
        type: 'function',
        function: {
          name: 'weather',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'required',
    }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: expect.stringMatching(/^call_[0-9a-f-]{36}$/),
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Boston"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    expect(invocations.requests[0]).toHaveProperty('outputSchema');
    expect(invocations.requests[0]).not.toHaveProperty('tools');
  });

  it('streams translated tool-call deltas and a tool_calls finish reason', async () => {
    invocations.events = [
      { type: 'structured_delta', delta: '{"type":"tool_calls","tool_calls":[{"name":"weather","arguments":{}}]}' },
      { type: 'completed' },
    ];
    const response = await chat(requestBody({
      stream: true,
      tools: [{ type: 'function', function: { name: 'weather' } }],
    }));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"tool_calls":[{"index":0,"id":"call_');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
    expect(response.body).toContain('data: [DONE]\n\n');
  });
});
