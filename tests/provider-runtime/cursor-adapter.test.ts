import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURSOR_SANDBOX_WARNING,
  CURSOR_SESSION_WARNING,
  CURSOR_TOOL_BRIDGE_WARNING,
  CursorProviderAdapter,
  renderCursorPrompt,
} from '../../src/provider-runtime/cursor/adapter.js';
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

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-clis/cursor-agent.mjs');
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string' },
  },
  required: ['type', 'content'],
};

interface InvocationRecord {
  kind: 'invocation';
  args: string[];
  stdin: string;
}

interface SignalRecord {
  kind: 'signal';
  signal: 'SIGINT';
}

interface Harness {
  adapter: CursorProviderAdapter;
  specs: ManagedProcessSpec[];
  invocations(): InvocationRecord[];
  signals(): SignalRecord[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness(scenario = 'text'): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'asq-cursor-adapter-'));
  const recordPath = join(directory, 'records.jsonl');
  const specs: ManagedProcessSpec[] = [];
  const processes = new Set<ManagedProcess>();
  const spawn: SpawnManagedProcess = (spec) => {
    specs.push(spec);
    const managed = spawnManagedProcess({
      command: process.execPath,
      args: [FIXTURE, ...spec.args],
      cwd: spec.cwd,
      env: {
        ...process.env,
        FAKE_CURSOR_SCENARIO: scenario,
        FAKE_CURSOR_RECORD: recordPath,
      },
    });
    processes.add(managed);
    void managed.exited.finally(() => processes.delete(managed)).catch(() => undefined);
    return managed;
  };
  const adapter = new CursorProviderAdapter({ spawnProcess: spawn });
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
    invocations: () => records().filter((record): record is InvocationRecord =>
      record.kind === 'invocation'),
    signals: () => records().filter((record): record is SignalRecord =>
      record.kind === 'signal'),
  };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'cursor-test',
    model: 'gpt-5.6-sol-max',
    effort: null,
    workspace: tmpdir(),
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

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('CursorProviderAdapter', () => {
  it('suppresses native thinking while streaming partial output with fixed Ask-mode sandbox flags', async () => {
    const h = harness();
    const providerRequest = request();

    const events = await collect(h.adapter.start(providerRequest));
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'cursor-session-1' },
      { type: 'text_delta', delta: 'Hello ' },
      { type: 'text_delta', delta: 'world' },
      { type: 'completed' },
    ]);
    expect(JSON.stringify(events)).not.toContain('Sensitive native reasoning');

    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]).toEqual(expect.objectContaining({
      command: 'cursor-agent',
      cwd: providerRequest.workspace,
      args: [
        '--print',
        '--output-format', 'stream-json',
        '--stream-partial-output',
        '--mode', 'ask',
        '--sandbox', 'enabled',
        '--trust',
        '--model', 'gpt-5.6-sol-max',
      ],
    }));
    expect(h.specs[0]?.args).not.toEqual(expect.arrayContaining([
      '--force', '--yolo', '--auto-review', '--approve-mcps', '--effort', '--workspace',
    ]));
    expect(JSON.stringify(h.specs[0]?.args)).not.toContain('Say hello.');
    expect(h.invocations()).toEqual([{
      kind: 'invocation',
      args: h.specs[0]?.args,
      stdin: renderCursorPrompt(providerRequest),
    }]);
  });

  it('resumes the exact Cursor session in a fresh print process', async () => {
    const h = harness();
    await collect(h.adapter.start(request({ sessionMode: 'persistent' })));
    const resumed = await collect(h.adapter.resume({
      ...request({ runId: 'run_2', sessionMode: 'persistent' }),
      nativeSessionId: 'cursor-external-session',
    } satisfies ProviderResumeRequest));

    expect(h.specs).toHaveLength(2);
    expect(h.specs[1]?.args.slice(-2)).toEqual(['--resume', 'cursor-external-session']);
    expect(resumed[0]).toEqual({
      type: 'session_started',
      nativeSessionId: 'cursor-external-session',
    });
  });

  it('streams prompt-constrained JSON without identity override tags', async () => {
    const h = harness();
    const providerRequest = request({ outputSchema: OUTPUT_SCHEMA });

    await expect(collect(h.adapter.start(providerRequest))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'cursor-session-1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text",' },
      { type: 'structured_delta', delta: '"content":"Confirmed."}' },
      { type: 'completed' },
    ]);
    const prompt = h.invocations()[0]?.stdin ?? '';
    expect(prompt).toContain(JSON.stringify(OUTPUT_SCHEMA));
    expect(prompt).toContain('Required response schema:');
    expect(prompt).not.toContain('<gateway_policy>');
    expect(prompt).not.toContain('You are responding through Agent Squad Gateway');
  });

  it('falls back to the aggregate result when partial output is unavailable', async () => {
    const h = harness('no-partial');
    await expect(collect(h.adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'cursor-session-1' },
      { type: 'text_delta', delta: 'Hello world' },
      { type: 'completed' },
    ]);
  });

  it('fails closed on every native tool event without exposing tool payloads', async () => {
    const h = harness('tool-call');
    const events = await collect(h.adapter.start(request()));

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'cursor-session-1' },
      {
        type: 'failed',
        code: 'adapter_protocol_error',
        message: 'Cursor provider protocol error',
        nativeStateAdvanced: true,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret\.txt|readToolCall|cursor-tool-1/);
  });

  it('rejects a final aggregate that does not match streamed deltas', async () => {
    const h = harness('aggregate-mismatch');
    const events = await collect(h.adapter.start(request()));
    expect(events.at(-1)).toEqual({
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'Cursor provider protocol error',
      nativeStateAdvanced: true,
    });
  });

  it('normalizes provider and process failures without stderr details', async () => {
    const provider = await collect(harness('provider-error').adapter.start(request()));
    expect(provider).toEqual([
      { type: 'session_started', nativeSessionId: 'cursor-session-1' },
      {
        type: 'failed',
        code: 'adapter_provider_failed',
        message: 'Cursor provider turn failed',
        nativeStateAdvanced: true,
      },
    ]);
    const processFailure = await collect(harness('nonzero').adapter.start(request()));
    expect(processFailure).toEqual([{
      type: 'failed',
      code: 'adapter_process_error',
      message: 'Cursor provider process error',
      nativeStateAdvanced: true,
    }]);
    expect(JSON.stringify(processFailure)).not.toContain('Sensitive');
  });

  it('maps abort to Cursor process interruption', async () => {
    const h = harness('cancel');
    const controller = new AbortController();
    const iterator = h.adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'session_started', nativeSessionId: 'cursor-session-1' },
    });
    const terminal = iterator.next();
    controller.abort();
    await expect(terminal).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await waitFor(() => h.signals().length === 1, 'Cursor SIGINT');
    expect(h.signals()).toEqual([{ kind: 'signal', signal: 'SIGINT' }]);
  });

  it('statically discovers exact Cursor models without starting a turn', async () => {
    const h = harness();
    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toEqual({
      available: true,
      version: '2026.07.09-test000',
      verified: false,
      modelSelection: true,
      effortSelection: false,
      modelOptions: [
        { id: 'auto', label: 'Auto (default)', effortOptions: null },
        { id: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol 1M Max', effortOptions: null },
        { id: 'claude-opus-4-8-thinking-high', label: 'Opus 4.8 1M Thinking', effortOptions: null },
      ],
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
      details: [CURSOR_SANDBOX_WARNING, CURSOR_SESSION_WARNING, CURSOR_TOOL_BRIDGE_WARNING],
    });
    expect(h.specs.map((spec) => [spec.command, spec.args])).toEqual([
      ['cursor-agent', ['--version']],
      ['cursor-agent', ['--help']],
      ['cursor-agent', ['--list-models']],
    ]);
    expect(h.invocations()).toHaveLength(0);
  });

  it('rejects a Cursor version missing a required safe flag', async () => {
    const h = harness('help-missing-flag');
    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toMatchObject({
      available: false,
      verified: false,
      error: 'adapter_capability_unsupported',
    });
  });

  it('conformance verifies structured streaming on start and resume', async () => {
    const h = harness();
    const capabilities = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'cursor-test',
      model: 'gpt-5.6-sol-max',
      effort: null,
      workspace: tmpdir(),
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
    });
    expect(Date.parse(capabilities.verifiedAt ?? '')).not.toBeNaN();
    expect(h.invocations()).toHaveLength(2);
    expect(h.invocations()[1]?.args).toContain('--resume');
    expect(h.invocations().every((invocation) =>
      invocation.stdin.includes('Required response schema:'))).toBe(true);
  });
});
