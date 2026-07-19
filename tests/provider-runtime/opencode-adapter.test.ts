import { describe, expect, it } from 'vitest';
import {
  OpenCodeProviderAdapter,
  ProviderConfigError,
  splitOpenCodeModel,
} from '../../src/provider-runtime/opencode/adapter.js';
import {
  OPENCODE_CONFIG,
  OpenCodeServer,
} from '../../src/provider-runtime/opencode/server.js';
import {
  API_PROVIDER_SYSTEM_INSTRUCTION,
  renderProviderInput,
} from '../../src/provider-runtime/provider-input.js';
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderResumeRequest,
} from '../../src/provider-runtime/types.js';
import { FakeOpenCode } from '../fixtures/fake-clis/opencode-server.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string' },
  },
  additionalProperties: false,
};

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'opencode-test',
    model: 'openai/gpt-5.6',
    effort: 'high',
    workspace: '/tmp/opencode-workspace',
    input: [{ role: 'user', content: 'Say hello.' }],
    sessionMode: 'ephemeral',
    runTimeoutMs: 30_000,
    outputSchema: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function harness(
  options: ConstructorParameters<typeof FakeOpenCode>[0] = {},
  adapterOptions: Record<string, unknown> = {},
) {
  const fake = new FakeOpenCode(options);
  const server = new OpenCodeServer(fake.factory);
  const adapter = new OpenCodeProviderAdapter({
    server,
    runCommand: fake.runCommand,
    ...adapterOptions,
  });
  return { adapter, fake, server };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('OpenCode pure SDK server', () => {
  it('binds an OS-selected loopback port with deny-all permissions and no extensions', async () => {
    const fake = new FakeOpenCode();
    const server = new OpenCodeServer(fake.factory);

    await server.start();

    expect(fake.options).toEqual({
      hostname: '127.0.0.1',
      port: 0,
      config: OPENCODE_CONFIG,
    });
    expect(fake.options?.config).toEqual({
      permission: { '*': 'deny' },
      mcp: {},
      plugin: [],
    });
    expect(fake.options?.config).not.toHaveProperty('server');
    expect(fake.options?.config).not.toHaveProperty('agent');
    expect(fake.options?.config).not.toHaveProperty('tools');

    await server.close();
    expect(fake.closeCount).toBe(1);
  });
});

describe('OpenCodeProviderAdapter', () => {
  it('splits the provider from the full native model ID', () => {
    expect(splitOpenCodeModel('openai/gpt-5.6')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6',
    });
    expect(splitOpenCodeModel('openrouter/anthropic/claude-opus-4.1')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude-opus-4.1',
    });
  });

  it.each(['openai', '/gpt-5.6', 'openai/'])('rejects invalid native model %s', (model) => {
    expect(() => splitOpenCodeModel(model)).toThrowError(ProviderConfigError);
    try {
      splitOpenCodeModel(model);
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_opencode_model' });
    }
  });

  it('rejects an invalid model before starting the SDK server or advancing native state', async () => {
    const { adapter, fake } = harness();

    await expect(collect(adapter.start(request({ model: 'invalid' })))).resolves.toEqual([{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'OpenCode provider protocol error',
      nativeStateAdvanced: false,
    }]);
    expect(fake.options).toBeUndefined();
    expect(fake.creates).toHaveLength(0);
    expect(fake.prompts).toHaveLength(0);
  });

  it('subscribes before prompting and forwards only matching unique text deltas', async () => {
    const { adapter, fake } = harness();
    const providerRequest = request();

    await expect(collect(adapter.start(providerRequest))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'ses_1' },
      { type: 'text_delta', delta: 'hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'completed' },
    ]);

    expect(fake.order.slice(0, 3)).toEqual([
      'event.subscribe', 'session.create', 'session.prompt',
    ]);
    expect(fake.creates).toEqual([{ directory: providerRequest.workspace }]);
    expect(fake.prompts).toHaveLength(1);
    expect(fake.prompts[0]).toMatchObject({
      sessionID: 'ses_1',
      directory: providerRequest.workspace,
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      variant: 'high',
      system: API_PROVIDER_SYSTEM_INSTRUCTION,
      parts: [{ type: 'text', text: renderProviderInput(providerRequest.input) }],
      format: { type: 'text' },
    });
    expect(fake.prompts[0]).not.toHaveProperty('agent');
    expect(fake.prompts[0]).not.toHaveProperty('tools');
    expect(fake.subscribeOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fake.createOptions[0]?.signal).toBe(fake.subscribeOptions[0]?.signal);
    expect(fake.promptOptions[0]?.signal).toBe(fake.subscribeOptions[0]?.signal);
  });

  it('passes staged images as native SDK file parts', async () => {
    const { adapter, fake } = harness();
    await collect(adapter.start(request({
      images: [{ path: '/tmp/staged image.webp', mediaType: 'image/webp', detail: 'low' }],
    })));

    expect(fake.prompts[0]?.parts).toEqual([
      { type: 'text', text: '<user>Say hello.</user>' },
      {
        type: 'file',
        mime: 'image/webp',
        filename: 'staged image.webp',
        url: 'file:///tmp/staged%20image.webp',
      },
    ]);
  });

  it('uses the generated JSON schema format and final assistant structured output', async () => {
    const { adapter, fake } = harness();

    await expect(collect(adapter.start(request({
      effort: null,
      outputSchema: OUTPUT_SCHEMA,
      sessionMode: 'persistent',
    })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'ses_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"Confirmed."}' },
      { type: 'completed' },
    ]);

    expect(fake.prompts[0]).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA, retryCount: 2 },
    });
    expect(fake.prompts[0]).not.toHaveProperty('variant');
    expect(fake.deletes).toHaveLength(0);
  });

  it('resumes the exact session without creating or deleting it', async () => {
    const { adapter, fake } = harness();
    const events = await collect(adapter.resume({
      ...request({ runId: 'run_resume', sessionMode: 'persistent' }),
      nativeSessionId: 'ses_external',
    } satisfies ProviderResumeRequest));

    expect(events[0]).toEqual({ type: 'session_started', nativeSessionId: 'ses_external' });
    expect(fake.creates).toHaveLength(0);
    expect(fake.prompts[0]).toMatchObject({ sessionID: 'ses_external' });
    expect(fake.deletes).toHaveLength(0);
  });

  it('deletes an ephemeral session after the turn completes', async () => {
    const { adapter, fake } = harness();
    await collect(adapter.start(request()));

    expect(fake.deletes).toEqual([{
      sessionID: 'ses_1',
      directory: '/tmp/opencode-workspace',
    }]);
    expect(fake.order.at(-1)).toBe('session.delete');
  });

  it.each(['tool', 'command', 'permission'] as const)(
    'fails closed on matching native %s activity without leaking details',
    async (unsafe) => {
      const { adapter } = harness({ unsafe });
      const events = await collect(adapter.start(request({ sessionMode: 'persistent' })));

      expect(events).toEqual([
        { type: 'session_started', nativeSessionId: 'ses_1' },
        {
          type: 'failed',
          code: 'adapter_protocol_error',
          message: 'OpenCode provider protocol error',
          nativeStateAdvanced: true,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('must-not-leak');
      expect(JSON.stringify(events)).not.toContain('call_sensitive');
    },
  );

  it('fails closed on an active-session v2 permission event without a message ID', async () => {
    const { adapter } = harness({ unsafe: 'permission-session-only' });

    await expect(collect(adapter.start(request({ sessionMode: 'persistent' })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'ses_1' },
      {
        type: 'failed',
        code: 'adapter_protocol_error',
        message: 'OpenCode provider protocol error',
        nativeStateAdvanced: true,
      },
    ]);
  });

  it.each(['question', 'mcp', 'file', 'native-tool'] as const)(
    'fails closed on matching provider-native %s activity',
    async (unsafe) => {
      const { adapter } = harness({ unsafe });
      const events = await collect(adapter.start(request({ sessionMode: 'persistent' })));

      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        code: 'adapter_protocol_error',
        nativeStateAdvanced: true,
      });
      expect(JSON.stringify(events)).not.toContain('must-not-leak');
      expect(JSON.stringify(events)).not.toContain('call_sensitive');
    },
  );

  it('ignores unsafe events attributed to another session', async () => {
    const { adapter } = harness({
      unsafe: 'permission-session-only',
      unsafeOtherSession: true,
    });

    await expect(collect(adapter.start(request({ sessionMode: 'persistent' })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'ses_1' },
      { type: 'completed' },
    ]);
  });

  it('cancels a blocking pre-prompt SDK operation through the request signal', async () => {
    const controller = new AbortController();
    const { adapter, fake } = harness({ waitForCreateAbort: true });
    const events = collect(adapter.start(request({
      signal: controller.signal,
      sessionMode: 'persistent',
    })));

    await waitFor(() => fake.order.includes('session.create'), 'OpenCode session creation');
    controller.abort();

    await expect(events).resolves.toEqual([{ type: 'cancelled' }]);
    expect(fake.prompts).toHaveLength(0);
    expect(fake.createOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    expect((fake.createOptions[0]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('maps cancellation to session.abort for the active native session', async () => {
    const { adapter, fake } = harness({ waitForAbort: true });
    const iterator = adapter.start(request({ sessionMode: 'persistent' }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'session_started', nativeSessionId: 'ses_1' },
    });
    const terminal = iterator.next();
    await waitFor(() => fake.order.includes('session.prompt'), 'OpenCode prompt');
    await adapter.cancel('run_1');

    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(fake.aborts).toEqual([{
      sessionID: 'ses_1',
      directory: '/tmp/opencode-workspace',
    }]);
  });

  it('bounds a hanging native session.abort request', async () => {
    const { adapter, fake } = harness(
      { waitForAbort: true, hangAbort: true },
      { nativeAbortTimeoutMs: 20 },
    );
    const iterator = adapter.start(request({ sessionMode: 'persistent' }))[Symbol.asyncIterator]();

    await iterator.next();
    const terminal = iterator.next();
    await waitFor(() => fake.order.includes('session.prompt'), 'OpenCode prompt');
    await adapter.cancel('run_1');

    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(fake.aborts).toHaveLength(1);
  });

  it('awaits iterator cleanup and swallows only its rejection', async () => {
    const { adapter, fake } = harness({
      iteratorCleanupDelayMs: 20,
      rejectIteratorCleanup: true,
    });

    await expect(collect(adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'ses_1' },
      { type: 'text_delta', delta: 'hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'completed' },
    ]);
    expect(fake.iteratorCleanupCount).toBe(1);
  });

  it('statically records the CLI version and lists models without starting the SDK server', async () => {
    const { adapter, fake } = harness();

    await expect(adapter.probeCapabilities({ mode: 'static' })).resolves.toEqual({
      available: true,
      version: '1.17.15',
      verified: false,
      modelSelection: true,
      effortSelection: true,
      modelOptions: [
        { id: 'openai/gpt-5.6', label: 'openai/gpt-5.6', effortOptions: null },
        {
          id: 'anthropic/claude-opus-4-1',
          label: 'anthropic/claude-opus-4-1',
          effortOptions: null,
        },
      ],
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
    });
    expect(fake.commands).toEqual([['--version'], ['models']]);
    expect(fake.options).toBeUndefined();
    expect(fake.prompts).toHaveLength(0);
  });

  it('keeps a different installed CLI version available until target conformance is verified', async () => {
    const { adapter, fake } = harness({ cliVersion: '1.17.18' });

    await expect(adapter.probeCapabilities({ mode: 'static' })).resolves.toMatchObject({
      available: true,
      version: '1.17.18',
      verified: false,
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });
    expect(fake.commands).toEqual([['--version'], ['models']]);
    expect(fake.options).toBeUndefined();
  });

  it('conformance uses only fake text, schema, and exact-resume turns', async () => {
    const { adapter, fake } = harness();

    const capabilities = await adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'opencode-test',
      model: 'openai/gpt-5.6',
      effort: 'high',
      workspace: '/tmp/opencode-workspace',
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
    });
    expect(Date.parse(capabilities.verifiedAt ?? '')).not.toBeNaN();
    expect(fake.prompts).toHaveLength(3);
    expect(fake.prompts.map((prompt) => (prompt.format as { type: string }).type))
      .toEqual(['text', 'json_schema', 'text']);
    expect(fake.creates).toHaveLength(2);
    expect(fake.prompts[2]?.sessionID).toBe(fake.prompts[0]?.sessionID);
  });

  it('conformance reports weaker capabilities after denied native activity', async () => {
    const { adapter } = harness({ unsafe: 'tool' });

    await expect(adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'opencode-test',
      model: 'openai/gpt-5.6',
      effort: null,
      workspace: '/tmp/opencode-workspace',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'best_effort',
      streamingMode: 'none',
      toolBridge: 'none',
    });
  });

  it('closes the SDK server during adapter disposal', async () => {
    const { adapter, fake } = harness();
    await collect(adapter.start(request({ sessionMode: 'persistent' })));

    await adapter.dispose();
    await adapter.dispose();

    expect(fake.closeCount).toBe(1);
  });
});
