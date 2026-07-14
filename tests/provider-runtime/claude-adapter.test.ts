import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeProviderAdapter } from '../../src/provider-runtime/claude/adapter.js';
import {
  API_PROVIDER_SYSTEM_INSTRUCTION,
  renderProviderInput,
} from '../../src/provider-runtime/provider-input.js';
import {
  spawnManagedProcess,
  type ManagedProcess,
  type ManagedProcessSpec,
  type SpawnManagedProcess,
} from '../../src/provider-runtime/process/managed-process.js';
import type {
  ProviderEvent,
  ProviderRequest,
  ProviderResumeRequest,
} from '../../src/provider-runtime/types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-clis/claude.mjs');
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string' },
  },
  additionalProperties: false,
};

interface InvocationRecord {
  kind: 'invocation';
  args: string[];
  stdin: string;
}

interface SignalRecord {
  kind: 'signal';
  target: 'parent' | 'child';
  signal: 'SIGINT';
}

interface Harness {
  adapter: ClaudeProviderAdapter;
  specs: ManagedProcessSpec[];
  invocations(): InvocationRecord[];
  signals(): SignalRecord[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness(scenario = 'text'): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'asq-claude-adapter-'));
  const recordPath = join(directory, 'records.jsonl');
  const specs: ManagedProcessSpec[] = [];
  const processes = new Set<ManagedProcess>();
  const spawn: SpawnManagedProcess = (spec) => {
    specs.push(spec);
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: [FIXTURE, ...spec.args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        FAKE_CLAUDE_SCENARIO: scenario,
        FAKE_CLAUDE_RECORD: recordPath,
      },
    });
    processes.add(managed);
    void managed.exited.finally(() => processes.delete(managed)).catch(() => undefined);
    return managed;
  };
  const adapter = new ClaudeProviderAdapter({ spawnProcess: spawn });
  cleanups.push(async () => {
    await Promise.allSettled([...processes].map((process) => process.dispose()));
    rmSync(directory, { recursive: true, force: true });
  });

  const records = (): Array<InvocationRecord | SignalRecord> => {
    try {
      return readFileSync(recordPath, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InvocationRecord | SignalRecord);
    } catch {
      return [];
    }
  };

  return {
    adapter,
    specs,
    invocations: () => records().filter((record): record is InvocationRecord => record.kind === 'invocation'),
    signals: () => records().filter((record): record is SignalRecord => record.kind === 'signal'),
  };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'claude-test',
    model: 'default',
    effort: 'max',
    workspace: '/tmp/claude-workspace',
    input: [{ role: 'user', content: 'Say hello.' }],
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

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ClaudeProviderAdapter', () => {
  it('disables Claude tools, MCP, skills, Chrome, and project customization', async () => {
    const h = harness();
    const providerRequest = request();

    await expect(collect(h.adapter.start(providerRequest))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'claude-session-1' },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'completed' },
    ]);

    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]).toEqual(expect.objectContaining({ command: 'claude', cwd: providerRequest.workspace }));
    expect(h.specs[0]?.args).toEqual([
      '--print', '--safe-mode', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--tools', '', '--permission-mode', 'dontAsk', '--no-chrome',
      '--system-prompt', API_PROVIDER_SYSTEM_INSTRUCTION,
      '--model', 'default', '--effort', 'max',
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--input-format', 'text', '--no-session-persistence',
    ]);
    expect(h.specs[0]?.args).not.toContain('--dangerously-skip-permissions');
    expect(h.specs[0]?.args).not.toContain('--bare');
    expect(JSON.stringify(h.specs[0]?.args)).not.toContain('Say hello.');
    expect(h.invocations()).toEqual([{
      kind: 'invocation',
      args: h.specs[0]?.args,
      stdin: renderProviderInput(providerRequest.input),
    }]);
  });

  it('uses a fresh persistent print process and resumes the exact native session', async () => {
    const h = harness();
    await collect(h.adapter.start(request({ sessionMode: 'persistent' })));
    const resumed = await collect(h.adapter.resume({
      ...request({ runId: 'run_2', sessionMode: 'persistent' }),
      nativeSessionId: 'claude-external-session',
    } satisfies ProviderResumeRequest));

    expect(h.specs).toHaveLength(2);
    expect(h.specs[0]?.args).not.toContain('--no-session-persistence');
    expect(h.specs[1]?.args).not.toContain('--no-session-persistence');
    expect(h.specs[1]?.args.slice(-2)).toEqual(['--resume', 'claude-external-session']);
    expect(resumed[0]).toEqual({
      type: 'session_started',
      nativeSessionId: 'claude-external-session',
    });
  });

  it('passes the exact JSON schema and emits only streamed structured deltas', async () => {
    const h = harness('schema-stream');
    const events = await collect(h.adapter.start(request({ outputSchema: OUTPUT_SCHEMA })));
    const args = h.specs[0]?.args ?? [];
    const schemaIndex = args.indexOf('--json-schema');

    expect(args.slice(schemaIndex, schemaIndex + 2)).toEqual([
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
    ]);
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'claude-session-1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"Confirmed."}' },
      { type: 'completed' },
    ]);
  });

  it('emits one aggregate structured delta when no schema stream is available', async () => {
    const h = harness('schema-result');
    await expect(collect(h.adapter.start(request({ outputSchema: OUTPUT_SCHEMA })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'claude-session-1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"Confirmed."}' },
      { type: 'completed' },
    ]);
  });

  it('normalizes an error result without exposing adapter-facing Claude details', async () => {
    const h = harness('provider-error');
    const events = await collect(h.adapter.start(request()));

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'claude-session-1' },
      {
        type: 'failed',
        code: 'adapter_provider_failed',
        message: 'Claude provider turn failed',
        nativeStateAdvanced: true,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Sensitive Claude fixture failure details');
  });

  it('marks native state advanced when protocol failure occurs after stdin delivery but before init', async () => {
    const h = harness('protocol-error-before-init');
    const providerRequest = request();
    const events = await collect(h.adapter.start(providerRequest));

    expect(h.invocations()).toEqual([expect.objectContaining({
      kind: 'invocation',
      stdin: renderProviderInput(providerRequest.input),
    })]);
    expect(events).toEqual([{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'Claude provider protocol error',
      nativeStateAdvanced: true,
    }]);
    expect(JSON.stringify(events)).not.toContain('Sensitive Claude pre-init fixture output');
    expect(JSON.stringify(events)).not.toContain('unexpected_event');
  });

  it.each(['tool_use', 'hook', 'mcp_tool_use', 'permission', 'future_block'])(
    'fails closed for a native %s content block without raw output',
    async (blockType) => {
      const h = harness(`unsafe-block:${blockType}`);
      const events = await collect(h.adapter.start(request()));

      expect(events).toEqual([
        { type: 'session_started', nativeSessionId: 'claude-session-1' },
        {
          type: 'failed',
          code: 'adapter_protocol_error',
          message: 'Claude provider protocol error',
          nativeStateAdvanced: true,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('unsafe_fixture_block');
      expect(JSON.stringify(events)).not.toContain(blockType);
    },
  );

  it('maps abort to process-tree interruption', async () => {
    const h = harness('cancel-tree');
    const controller = new AbortController();
    const iterator = h.adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'session_started', nativeSessionId: 'claude-session-1' },
    });
    const terminal = iterator.next();
    controller.abort();

    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await waitFor(() => h.signals().length === 2, 'Claude fixture process-tree signals');
    expect(h.signals()).toEqual(expect.arrayContaining([
      { kind: 'signal', target: 'parent', signal: 'SIGINT' },
      { kind: 'signal', target: 'child', signal: 'SIGINT' },
    ]));
  });

  it('normalizes direct run cancellation after interrupting the process tree', async () => {
    const h = harness('cancel-tree');
    const iterator = h.adapter.start(request())[Symbol.asyncIterator]();

    await iterator.next();
    const terminal = iterator.next();
    await h.adapter.cancel('run_1');

    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await waitFor(() => h.signals().length === 2, 'direct cancellation process-tree signals');
  });

  it('statically verifies the safe Claude flag ceiling without starting a turn', async () => {
    const h = harness();

    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toEqual({
      available: true,
      version: '9.9.9-test',
      verified: false,
      modelSelection: true,
      effortSelection: true,
      modelOptions: [{
        id: 'default',
        label: 'Claude Code default',
        effortOptions: ['low', 'medium', 'high', 'xhigh', 'max'],
      }],
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
    });
    expect(h.specs.map((spec) => [spec.command, spec.args])).toEqual([
      ['claude', ['--version']],
      ['claude', ['--help']],
    ]);
    expect(h.invocations()).toHaveLength(0);
  });

  it('does not advertise availability when a required safe flag is missing', async () => {
    const h = harness('help-missing-flag');
    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toMatchObject({
      available: false,
      verified: false,
      toolBridge: 'none',
      error: 'adapter_capability_unsupported',
    });
  });

  it('conformance verifies one English schema start and one English resume in strict isolation', async () => {
    const h = harness('schema-stream');
    const capabilities = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'claude-test',
      model: 'default',
      effort: 'max',
      workspace: '/tmp/claude-workspace',
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'strict',
      toolBridge: 'structured_output',
    });
    expect(Date.parse(capabilities.verifiedAt ?? '')).not.toBeNaN();
    expect(h.invocations()).toHaveLength(2);
    expect(h.invocations().every((invocation) => invocation.stdin.includes('Return'))).toBe(true);
    expect(h.invocations().every((invocation) => invocation.args.includes('--json-schema'))).toBe(true);
    expect(h.invocations()[1]?.args).toContain('--resume');
    expect(JSON.stringify(h.invocations().map((invocation) => invocation.stdin)))
      .not.toMatch(/tool_use|hook|mcp_tool_use|permission/);
  });

  it('downgrades the tool bridge when conformance only exposes aggregate schema output', async () => {
    const h = harness('schema-result');
    await expect(h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'claude-test',
      model: 'default',
      effort: 'max',
      workspace: '/tmp/claude-workspace',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'strict',
      toolBridge: 'none',
    });
  });
});
