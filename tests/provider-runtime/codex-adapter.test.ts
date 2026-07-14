import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexProviderAdapter } from '../../src/provider-runtime/codex/adapter.js';
import { CodexJsonRpcClient } from '../../src/provider-runtime/codex/json-rpc-client.js';
import {
  spawnManagedProcess,
  type ManagedProcessSpec,
  type SpawnManagedProcess,
} from '../../src/provider-runtime/process/managed-process.js';
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderResumeRequest,
} from '../../src/provider-runtime/types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-clis/codex-app-server.mjs');
const TOOL_ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { type: 'string', const: 'assistant_text' },
    content: { type: 'string' },
  },
};

interface Harness {
  adapter: CodexProviderAdapter;
  spawn: SpawnManagedProcess;
  requests(): Array<Record<string, unknown>>;
  specs: ManagedProcessSpec[];
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness(scenario = 'structured'): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'asq-codex-adapter-'));
  const recordPath = join(directory, 'requests.jsonl');
  const specs: ManagedProcessSpec[] = [];
  const processes = new Set<ReturnType<SpawnManagedProcess>>();
  const spawn: SpawnManagedProcess = (spec) => {
    specs.push(spec);
    const isVersion = spec.args.length === 1 && spec.args[0] === '--version';
    const isHelp = spec.args.length === 2 && spec.args[0] === 'app-server' && spec.args[1] === '--help';
    const managed = isVersion || isHelp
      ? spawnManagedProcess({
          command: process.execPath,
          args: ['-e', `process.stdout.write(${JSON.stringify(isVersion ? 'codex-cli 0.1.0-test\\n' : 'Usage: codex app-server --stdio\\n')})`],
          cwd: process.cwd(),
          env: process.env,
        })
      : spawnManagedProcess({
          command: process.execPath,
          args: [FIXTURE],
          cwd: process.cwd(),
          env: { ...process.env, FAKE_CODEX_SCENARIO: scenario, FAKE_CODEX_RECORD: recordPath },
        });
    processes.add(managed);
    void managed.exited.finally(() => processes.delete(managed)).catch(() => undefined);
    return managed;
  };
  const adapter = new CodexProviderAdapter({ spawnProcess: spawn });
  const cleanup = async () => {
    await adapter.dispose();
    await Promise.allSettled([...processes].map((process) => process.dispose()));
    rmSync(directory, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return {
    adapter,
    spawn,
    specs,
    requests: () => {
      try {
        return readFileSync(recordPath, 'utf8').trim().split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    cleanup,
  };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'codex-test',
    model: 'gpt-5.6',
    effort: 'max',
    workspace: '/tmp/codex-workspace',
    input: [{ role: 'user', content: 'Say ok.' }],
    sessionMode: 'ephemeral',
    runTimeoutMs: 30_000,
    outputSchema: null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function findRequest(h: Harness, method: string): Record<string, unknown> | undefined {
  return h.requests().find((entry) => entry.method === method);
}

async function waitForRequest(h: Harness, method: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!findRequest(h, method)) {
    if (Date.now() >= deadline) throw new Error(`fixture did not receive ${method}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('CodexProviderAdapter', () => {
  it('starts an ephemeral read-only thread without tools or environments', async () => {
    const h = harness();
    const events = await collect(h.adapter.start(request({ outputSchema: TOOL_ENVELOPE_SCHEMA })));

    expect(findRequest(h, 'initialize')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'agent-squad-gateway', title: 'agent-squad-gateway', version: '0.1.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: expect.arrayContaining([
            'thread/started',
            'thread/status/changed',
            'turn/started',
            'mcpServer/startupStatus/updated',
          ]),
        },
      },
    });
    expect(findRequest(h, 'thread/start')?.params).toMatchObject({
      model: 'gpt-5.6',
      cwd: '/tmp/codex-workspace',
      runtimeWorkspaceRoots: ['/tmp/codex-workspace'],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    });
    expect(findRequest(h, 'turn/start')?.params).toMatchObject({
      threadId: 'thread_1',
      model: 'gpt-5.6',
      effort: 'max',
      environments: [],
      outputSchema: TOOL_ENVELOPE_SCHEMA,
      input: [{ type: 'text', text: '<user>Say ok.</user>', text_elements: [] }],
    });
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"ok"}' },
      { type: 'completed' },
    ]);
  });

  it('starts persistent threads and resumes the exact native thread ID', async () => {
    const h = harness('text');
    await collect(h.adapter.start(request({ sessionMode: 'persistent' })));
    const resumed = await collect(h.adapter.resume({
      ...request({ runId: 'run_2', sessionMode: 'persistent' }),
      nativeSessionId: 'thread_external_7',
    } satisfies ProviderResumeRequest));

    expect(findRequest(h, 'thread/start')?.params).toMatchObject({ ephemeral: false });
    expect(findRequest(h, 'thread/resume')?.params).toEqual(expect.objectContaining({
      threadId: 'thread_external_7',
      model: 'gpt-5.6',
      cwd: '/tmp/codex-workspace',
      runtimeWorkspaceRoots: ['/tmp/codex-workspace'],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      excludeTurns: true,
    }));
    expect(resumed).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_external_7' },
      { type: 'text_delta', delta: 'plain ' },
      { type: 'text_delta', delta: 'text' },
      { type: 'completed' },
    ]);
  });

  it('routes interleaved notifications independently to concurrent runs', async () => {
    const h = harness('concurrent');
    const [first, second] = await Promise.all([
      collect(h.adapter.start(request({ runId: 'run_1' }))),
      collect(h.adapter.start(request({ runId: 'run_2' }))),
    ]);

    expect(first).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'text_delta', delta: 'thread_1:a' },
      { type: 'text_delta', delta: 'thread_1:b' },
      { type: 'completed' },
    ]);
    expect(second).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_2' },
      { type: 'text_delta', delta: 'thread_2:a' },
      { type: 'text_delta', delta: 'thread_2:b' },
      { type: 'completed' },
    ]);
  }, 2_000);

  it.each([
    ['failed', { type: 'failed', code: 'adapter_provider_failed', message: 'provider turn failed', nativeStateAdvanced: true }],
    ['interrupted', { type: 'cancelled' }],
  ])('normalizes a %s turn exactly once', async (scenario, terminal) => {
    const h = harness(scenario);
    const events = await collect(h.adapter.start(request()));
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      terminal,
    ]);
  });

  it('normalizes malformed JSON-RPC without including the raw line', async () => {
    const h = harness('malformed');
    const events = await collect(h.adapter.start(request()));
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'failed', code: 'adapter_protocol_error', message: 'provider protocol error', nativeStateAdvanced: true },
    ]);
    expect(JSON.stringify(events)).not.toContain('malformed json');
  });

  it('correlates delayed responses while notifications are fragmented', async () => {
    const h = harness('out-of-order-responses');
    await expect(collect(h.adapter.start(request({ outputSchema: TOOL_ENVELOPE_SCHEMA })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"ok"}' },
      { type: 'completed' },
    ]);
  });

  it('accepts current Codex lifecycle and telemetry notifications', async () => {
    const h = harness('modern-notifications');
    await expect(collect(h.adapter.start(request({ outputSchema: TOOL_ENVELOPE_SCHEMA })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"ok"}' },
      { type: 'completed' },
    ]);
    await expect(collect(h.adapter.resume({
      ...request({ runId: 'run_2', outputSchema: TOOL_ENVELOPE_SCHEMA }),
      nativeSessionId: 'thread_1',
    }))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"ok"}' },
      { type: 'completed' },
    ]);
  });

  it('correlates concurrent JSON-RPC responses by numeric ID', async () => {
    const h = harness();
    const managed = h.spawn({
      command: 'codex',
      args: ['app-server', '--stdio'],
      cwd: process.cwd(),
      env: process.env,
    });
    const client = new CodexJsonRpcClient(managed);
    await client.request('initialize', {
      clientInfo: { name: 'agent-squad-gateway', title: 'agent-squad-gateway', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    client.notify('initialized');

    const slow = client.request<{ value: string }>('test/echo', { value: 'slow', delayMs: 20 });
    const fast = client.request<{ value: string }>('test/echo', { value: 'fast', delayMs: 0 });
    await expect(Promise.all([slow, fast])).resolves.toEqual([{ value: 'slow' }, { value: 'fast' }]);
  });

  it.each([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'requestApproval',
  ])('rejects provider-native %s item surfaces', async (itemType) => {
    const h = harness(`unsafe-item:${itemType}`);
    await expect(collect(h.adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'failed', code: 'adapter_protocol_error', message: 'provider protocol error', nativeStateAdvanced: true },
    ]);
  });

  it.each([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'mcpServer/request',
    'dynamicTool/call',
    'approval/request',
  ])('rejects incoming %s JSON-RPC server requests', async (method) => {
    const h = harness(`server-request:${method}`);
    await expect(collect(h.adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'failed', code: 'adapter_protocol_error', message: 'provider protocol error', nativeStateAdvanced: true },
    ]);
  });

  it('restarts the app-server after a protocol failure', async () => {
    const h = harness('malformed');
    await collect(h.adapter.start(request()));
    await collect(h.adapter.start(request({ runId: 'run_2' })));

    expect(h.specs.filter((spec) => spec.args.join(' ') === 'app-server --stdio')).toHaveLength(2);
  });

  it('rejects pending work and restarts after the app-server exits', async () => {
    const h = harness('exit-after-turn-start');
    await expect(collect(h.adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'failed', code: 'adapter_process_error', message: 'provider process error', nativeStateAdvanced: true },
    ]);
    await collect(h.adapter.start(request({ runId: 'run_2' })));
    expect(h.specs.filter((spec) => spec.args.join(' ') === 'app-server --stdio')).toHaveLength(2);
  });

  it('drains final JSON-RPC frames written immediately before normal process exit', async () => {
    const h = harness('write-then-exit');
    await expect(collect(h.adapter.start(request({ outputSchema: TOOL_ENVELOPE_SCHEMA })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'thread_1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"ok"}' },
      { type: 'completed' },
    ]);
  });

  it('maps AbortSignal to turn/interrupt', async () => {
    const h = harness('wait-for-interrupt');
    const controller = new AbortController();
    const iterator = h.adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'session_started', nativeSessionId: 'thread_1' },
    });
    const terminal = iterator.next();
    controller.abort();
    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(findRequest(h, 'turn/interrupt')?.params).toEqual({ threadId: 'thread_1', turnId: 'turn_1' });
  });

  it('restarts within two seconds when turn/interrupt never responds', async () => {
    const h = harness('unanswered-interrupt');
    const iterator = h.adapter.start(request())[Symbol.asyncIterator]();
    await iterator.next();
    const terminal = iterator.next();
    await waitForRequest(h, 'turn/start');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const cancellationRequestedAt = Date.now();
    await expect(h.adapter.cancel('run_1')).resolves.toBeUndefined();
    expect(Date.now() - cancellationRequestedAt).toBeLessThan(3_000);
    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    const restarted = h.adapter.start(request({ runId: 'run_2' }))[Symbol.asyncIterator]();
    await restarted.next();
    expect(h.specs.filter((spec) => spec.args.join(' ') === 'app-server --stdio')).toHaveLength(2);
    await restarted.return?.();
  }, 5_000);

  it('probes version, help, and model metadata without starting a turn', async () => {
    const h = harness();
    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toEqual({
      available: true,
      version: '0.1.0-test',
      verified: false,
      modelSelection: true,
      effortSelection: true,
      modelOptions: [
        { id: 'gpt-5.6', label: 'GPT-5.6', effortOptions: ['low', 'high', 'max'] },
        { id: 'gpt-5.6-mini', label: 'GPT-5.6 Mini', effortOptions: null },
      ],
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
    });
    expect(h.specs.map((spec) => [spec.command, spec.args])).toEqual([
      ['codex', ['--version']],
      ['codex', ['app-server', '--help']],
      ['codex', ['app-server', '--stdio']],
    ]);
    expect(h.requests().some((entry) => entry.method === 'turn/start')).toBe(false);
    expect(findRequest(h, 'model/list')).toBeDefined();
  });

  it('conformance performs one schema-constrained start and resume', async () => {
    const h = harness();
    const capabilities = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'codex-test',
      model: 'gpt-5.6',
      effort: 'max',
      workspace: '/tmp/codex-workspace',
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({ available: true, verified: true, version: '0.1.0-test' });
    expect(Date.parse(capabilities.verifiedAt ?? '')).not.toBeNaN();
    expect(h.requests().filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
    expect(h.requests().filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
    const turns = h.requests().filter((entry) => entry.method === 'turn/start');
    expect(turns).toHaveLength(2);
    expect(turns.every((entry) => {
      const params = entry.params as Record<string, unknown>;
      return params.outputSchema !== null && Array.isArray(params.environments)
        && params.environments.length === 0;
    })).toBe(true);
    expect(turns.every((entry) => {
      const schema = (entry.params as {
        outputSchema?: { properties?: { type?: { type?: unknown; const?: unknown } } };
      }).outputSchema;
      return schema?.properties?.type?.type === 'string'
        && schema.properties.type.const === 'assistant_text';
    })).toBe(true);
    expect(JSON.stringify(h.requests())).not.toContain('dynamicTools":[{');
  });

  it.each([
    'invalid-structured-json',
    'invalid-structured-schema',
  ])('does not verify structured output for %s conformance payloads', async (scenario) => {
    const h = harness(scenario);
    const capabilities = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'codex-test',
      model: 'gpt-5.6',
      effort: 'max',
      workspace: '/tmp/codex-workspace',
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({
      available: false,
      verified: false,
      toolBridge: 'none',
      error: 'adapter_protocol_error',
    });
  });
});
