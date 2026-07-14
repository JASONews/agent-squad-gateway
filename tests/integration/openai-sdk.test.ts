import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import OpenAI, { APIError } from 'openai';
import { expect, it, vi } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { ResponseSessionRepository } from '../../src/control-plane/response-sessions.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import {
  FakeProviderAdapter,
  type FakeProviderAdapterOptions,
} from '../../src/provider-runtime/fake/adapter.js';
import { InvocationService } from '../../src/provider-runtime/invocation-service.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../src/server/app.js';

const MODEL = 'sdk-model';
const VERIFIED_CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};

it('serves the official OpenAI SDK contract over a real Gateway listener', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'asq-gateway-openai-sdk-'));
  let app: FastifyInstance | undefined;
  let db: GatewayDb | undefined;

  try {
    const config = resolveGatewayConfig({ baseDir });
    db = openGatewayDb(':memory:');
    const clients = new ClientRepository(db);
    const credentials = new CredentialService(db, Buffer.alloc(32, 5));
    const extensions = new ExtensionRepository(db);
    const grants = new GrantRepository(db);
    const targets = new TargetRepository(db);
    const runs = new RunRepository(db);
    const responseSessions = new ResponseSessionRepository(db);
    const responseWorkspaces = new WorkspaceManager(config.paths.workspacesDir, {
      getFixedWorkspaces: () => targets.list()
        .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
    });
    const providerOptions: FakeProviderAdapterOptions = {
      chunks: ['SDK ', 'response'],
    };
    const provider = new FakeProviderAdapter(providerOptions);
    const providerStart = vi.spyOn(provider, 'start');
    const providerResume = vi.spyOn(provider, 'resume');
    const registry = new ProviderRegistry();
    registry.register('fake', provider);
    const invocationService = new InvocationService(
      registry,
      new TargetScheduler(),
      responseWorkspaces,
      targets,
      runs,
    );

    app = buildGatewayApp({
      config,
      db,
      clients,
      credentials,
      extensions,
      grants,
      targets,
      runs,
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 7)),
      invocationService,
      responseSessions,
      responseWorkspaces,
    });

    const gatewayClient = clients.create('official-openai-sdk');
    const apiKey = credentials.create(gatewayClient.id, 'primary').apiKey;
    extensions.upsert('openai', '1.0.0', true);
    targets.create({
      id: MODEL,
      aliases: ['sdk-alias'],
      cli: 'fake',
      nativeModel: 'fake',
      reasoningEffort: 'medium',
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      maxConcurrency: 1,
      maxQueue: 8,
      queueTimeoutMs: 300_000,
      runTimeoutMs: null,
    });
    targets.setCapability(MODEL, {
      version: '1.0.0',
      verifiedAt: '2026-07-12T12:00:00.000Z',
      capabilities: VERIFIED_CAPABILITIES,
    });
    targets.update(MODEL, { enabled: true });
    grants.grant(gatewayClient.id, 'openai', MODEL);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const openai = new OpenAI({ apiKey, baseURL: `${baseUrl}/v1` });

    const models = await openai.models.list();
    expect(models.data.map(({ id, owned_by: ownedBy }) => ({ id, ownedBy }))).toEqual([
      { id: 'sdk-alias', ownedBy: 'agent-squad-gateway' },
      { id: MODEL, ownedBy: 'agent-squad-gateway' },
    ]);

    const chat = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Reply through Chat Completions.' }],
    });
    expect(chat.choices[0]?.message).toMatchObject({ role: 'assistant', content: 'SDK response' });

    const chatStream = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'Stream through Chat Completions.' }],
      stream: true,
    });
    const chatEvents = [];
    try {
      for await (const event of chatStream) chatEvents.push(event);
    } finally {
      chatStream.controller.abort();
    }
    expect(chatEvents.length).toBeGreaterThan(1);
    expect(chatEvents.flatMap((event) => event.choices)
      .map((choice) => choice.delta.content ?? '')
      .join('')).toBe('SDK response');

    const startsBeforeStoredResponse = providerStart.mock.calls.length;
    const resumesBeforeStoredResponse = providerResume.mock.calls.length;
    const response = await openai.responses.create({
      model: MODEL,
      input: 'Reply through Responses.',
    });
    expect(response.output_text).toBe('SDK response');
    expect(providerStart).toHaveBeenCalledTimes(startsBeforeStoredResponse + 1);
    expect(providerResume).toHaveBeenCalledTimes(resumesBeforeStoredResponse);
    const storedStartRequest = providerStart.mock.calls.at(-1)![0];
    const storedNativeSessionId = `fake_session_${storedStartRequest.runId}`;
    expect(responseSessions.get(response.id)).toMatchObject({
      responseId: response.id,
      nativeSessionId: storedNativeSessionId,
      workspacePath: storedStartRequest.workspace,
      state: 'open',
    });

    const responseStream = await openai.responses.create({
      model: MODEL,
      input: 'Stream through Responses.',
      store: false,
      stream: true,
    });
    const responseEvents = [];
    try {
      for await (const event of responseStream) responseEvents.push(event);
    } finally {
      responseStream.controller.abort();
    }
    expect(responseEvents.length).toBeGreaterThan(1);
    expect(responseEvents
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.delta)
      .join('')).toBe('SDK response');

    const startsBeforeStoredResume = providerStart.mock.calls.length;
    const resumesBeforeStoredResume = providerResume.mock.calls.length;
    const resumed = await openai.responses.create({
      model: MODEL,
      input: 'Resume the previous response.',
      previous_response_id: response.id,
    });
    expect(resumed.output_text).toBe('SDK response');
    expect(providerStart).toHaveBeenCalledTimes(startsBeforeStoredResume);
    expect(providerResume).toHaveBeenCalledTimes(resumesBeforeStoredResume + 1);
    const storedResumeRequest = providerResume.mock.calls.at(-1)![0];
    expect(storedResumeRequest).toMatchObject({
      nativeSessionId: storedNativeSessionId,
      workspace: storedStartRequest.workspace,
    });
    expect(responseSessions.get(response.id)).toMatchObject({
      responseId: response.id,
      nativeSessionId: storedNativeSessionId,
      workspacePath: storedStartRequest.workspace,
      state: 'continued',
      childResponseId: resumed.id,
    });
    expect(responseSessions.get(resumed.id)).toMatchObject({
      responseId: resumed.id,
      parentResponseId: response.id,
      nativeSessionId: storedNativeSessionId,
      workspacePath: storedStartRequest.workspace,
      state: 'open',
    });

    const tools: OpenAI.Responses.Tool[] = [{
      type: 'function',
      name: 'weather',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }];
    providerOptions.structuredEnvelope = {
      type: 'tool_calls',
      tool_calls: [{ name: 'weather', arguments: { city: 'Boston' } }],
    };
    const startsBeforeFunctionRequest = providerStart.mock.calls.length;
    const functionRequest = await openai.responses.create({
      model: MODEL,
      input: 'What is the weather?',
      tools,
      tool_choice: 'required',
    });
    expect(providerStart).toHaveBeenCalledTimes(startsBeforeFunctionRequest + 1);
    const functionStartRequest = providerStart.mock.calls.at(-1)![0];
    const functionNativeSessionId = `fake_session_${functionStartRequest.runId}`;
    expect(responseSessions.get(functionRequest.id)).toMatchObject({
      responseId: functionRequest.id,
      nativeSessionId: functionNativeSessionId,
      workspacePath: functionStartRequest.workspace,
      state: 'open',
    });
    const functionCall = functionRequest.output.find((item) => item.type === 'function_call');
    expect(functionCall).toMatchObject({
      type: 'function_call',
      name: 'weather',
      arguments: '{"city":"Boston"}',
    });
    if (!functionCall || functionCall.type !== 'function_call') {
      throw new Error('Gateway did not return an SDK function-call item');
    }

    providerOptions.structuredEnvelope = {
      type: 'assistant_text',
      content: 'Weather is sunny',
    };
    const startsBeforeFunctionResume = providerStart.mock.calls.length;
    const resumesBeforeFunctionResume = providerResume.mock.calls.length;
    const functionResult = await openai.responses.create({
      model: MODEL,
      previous_response_id: functionRequest.id,
      input: [{
        type: 'function_call_output',
        call_id: functionCall.call_id,
        output: '72 F and sunny',
      }],
      tools,
    });
    expect(functionResult.output_text).toBe('Weather is sunny');
    expect(providerStart).toHaveBeenCalledTimes(startsBeforeFunctionResume);
    expect(providerResume).toHaveBeenCalledTimes(resumesBeforeFunctionResume + 1);
    const functionResumeRequest = providerResume.mock.calls.at(-1)![0];
    expect(functionResumeRequest.input).toEqual([{
      role: 'tool',
      toolCallId: functionCall.call_id,
      content: '72 F and sunny',
    }]);
    expect(functionResumeRequest).toMatchObject({
      nativeSessionId: functionNativeSessionId,
      workspace: functionStartRequest.workspace,
    });

    let unknownModelError: unknown;
    try {
      await openai.chat.completions.create({
        model: 'missing-sdk-model',
        messages: [{ role: 'user', content: 'This must fail.' }],
      });
    } catch (error) {
      unknownModelError = error;
    }
    expect(unknownModelError).toBeInstanceOf(APIError);
    expect(unknownModelError).toMatchObject({ status: 404, code: 'model_not_found' });
    expect(runs.list().filter((run) => run.targetId === 'missing-sdk-model')).toEqual([
      expect.objectContaining({
        clientId: gatewayClient.id,
        endpoint: 'chat.completions',
        status: 'failed',
        errorCode: 'model_not_found',
      }),
    ]);
  } finally {
    vi.useRealTimers();
    try {
      await app?.close();
    } finally {
      try {
        db?.close();
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  }
});
