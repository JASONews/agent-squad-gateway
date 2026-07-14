import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_ARGV_WARNING,
  ANTIGRAVITY_TOOL_BRIDGE_WARNING,
  AntigravityProviderAdapter,
  renderAntigravityPrompt,
} from '../../src/provider-runtime/antigravity/adapter.js';
import {
  formatAgyTimeout,
  getAntigravityConversationId,
} from '../../src/provider-runtime/antigravity/conversation.js';
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

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-clis/agy.mjs');
const START_CONVERSATION = '11111111-2222-4333-8444-555555555555';
const RESUME_CONVERSATION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface RecordEntry {
  kind: 'probe' | 'invocation' | 'signal';
  args?: string[];
  signal?: 'SIGINT';
}

interface Harness {
  adapter: AntigravityProviderAdapter;
  home: string;
  workspace: string;
  specs: ManagedProcessSpec[];
  records(): RecordEntry[];
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness(scenario = 'text'): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'asq-agy-adapter-'));
  const home = join(directory, 'home');
  const workspace = join(directory, 'workspace');
  const recordPath = join(directory, 'records.jsonl');
  mkdirSync(home);
  mkdirSync(workspace);
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
        FAKE_AGY_SCENARIO: scenario,
        FAKE_AGY_RECORD: recordPath,
        FAKE_AGY_HOME: home,
        FAKE_AGY_CONVERSATION: START_CONVERSATION,
      },
    });
    processes.add(managed);
    void managed.exited.finally(() => processes.delete(managed)).catch(() => undefined);
    return managed;
  };
  const adapter = new AntigravityProviderAdapter({ spawnProcess: spawn, homeDir: home });
  cleanups.push(async () => {
    await Promise.allSettled([...processes].map((managed) => managed.dispose()));
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    adapter,
    home,
    workspace,
    specs,
    records: () => {
      try {
        return readFileSync(recordPath, 'utf8').trim().split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RecordEntry);
      } catch {
        return [];
      }
    },
  };
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'antigravity-test',
    model: 'Gemini 3.5 Flash (High)',
    effort: 'high',
    workspace: '/tmp/antigravity-workspace',
    input: [{ role: 'user', content: 'Say hello.' }],
    sessionMode: 'persistent',
    runTimeoutMs: 1_200_000,
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

function writeConversationCache(home: string, cache: unknown): void {
  const directory = join(home, '.gemini', 'antigravity-cli', 'cache');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'last_conversations.json'), JSON.stringify(cache));
}

describe('Antigravity conversation lookup', () => {
  it('uses the stable workspace realpath and accepts only UUID-shaped values', () => {
    const root = mkdtempSync(join(tmpdir(), 'asq-agy-conversation-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    mkdirSync(home);
    mkdirSync(workspace);
    symlinkSync(workspace, alias);
    writeConversationCache(home, { [realpathSync(workspace)]: START_CONVERSATION });

    expect(getAntigravityConversationId(home, alias)).toBe(START_CONVERSATION);
    writeConversationCache(home, { [realpathSync(workspace)]: 'not-a-uuid' });
    expect(getAntigravityConversationId(home, alias)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns null for missing, malformed, non-record, and unresolvable caches', () => {
    const root = mkdtempSync(join(tmpdir(), 'asq-agy-conversation-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home);
    mkdirSync(workspace);

    expect(getAntigravityConversationId(home, workspace)).toBeNull();
    writeConversationCache(home, null);
    expect(getAntigravityConversationId(home, workspace)).toBeNull();
    writeFileSync(
      join(home, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'),
      '{malformed',
    );
    expect(getAntigravityConversationId(home, workspace)).toBeNull();
    expect(getAntigravityConversationId(home, join(root, 'missing-workspace'))).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it('formats exact minute ceilings and a bounded null timeout', () => {
    expect(formatAgyTimeout(null)).toBe('8760h');
    expect(formatAgyTimeout(0)).toBe('1m');
    expect(formatAgyTimeout(60_001)).toBe('2m');
    expect(formatAgyTimeout(1_200_000)).toBe('20m');
  });
});

describe('AntigravityProviderAdapter', () => {
  it('keeps every flag before --print so the prompt is a clean final argument', async () => {
    const h = harness();
    const input = [{ role: 'user' as const, content: 'Say hello.' }];
    const events = await collect(h.adapter.start(request({
      workspace: h.workspace,
      input,
      model: 'Gemini 3.5 Flash (High)',
      effort: null,
    })));
    const args = h.records().find((entry) => entry.kind === 'invocation')?.args ?? [];
    const print = args.indexOf('--print');

    expect(args.slice(0, print)).toEqual([
      '--sandbox', '--model', 'Gemini 3.5 Flash (High)', '--print-timeout', '20m',
    ]);
    expect(args.slice(print)).toEqual(['--print', renderAntigravityPrompt({
      input,
      outputSchema: null,
    })]);
    expect(args).not.toContain('--effort');
    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: START_CONVERSATION },
      { type: 'text_delta', delta: 'final answer' },
      { type: 'completed' },
    ]);
  });

  it('passes null timeout as 8760h and ignores a separate effort value', async () => {
    const h = harness();
    await collect(h.adapter.start(request({
      workspace: h.workspace,
      runTimeoutMs: null,
      effort: 'maximum',
    })));
    const args = h.records().find((entry) => entry.kind === 'invocation')?.args ?? [];

    expect(args.slice(0, args.indexOf('--print'))).toEqual([
      '--sandbox', '--model', 'Gemini 3.5 Flash (High)', '--print-timeout', '8760h',
    ]);
    expect(args).not.toContain('--effort');
  });

  it('resumes the exact conversation before --print and keeps the supplied ID', async () => {
    const h = harness();
    const events = await collect(h.adapter.resume({
      ...request({ runId: 'run_resume', workspace: h.workspace }),
      nativeSessionId: RESUME_CONVERSATION,
    } satisfies ProviderResumeRequest));
    const args = h.records().find((entry) => entry.kind === 'invocation')?.args ?? [];

    expect(args.slice(args.indexOf('--conversation'), args.indexOf('--print'))).toEqual([
      '--conversation', RESUME_CONVERSATION,
    ]);
    expect(args.at(-1)).toBe(renderAntigravityPrompt({
      input: request().input,
      outputSchema: null,
    }));
    expect(events[0]).toEqual({ type: 'session_started', nativeSessionId: RESUME_CONVERSATION });
  });

  it('fails after a successful start when no valid conversation is exposed', async () => {
    const h = harness('missing-conversation');
    await expect(collect(h.adapter.start(request({ workspace: h.workspace })))).resolves.toEqual([{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'Antigravity provider protocol error',
      nativeStateAdvanced: true,
    }]);
  });

  it('rejects a stale conversation ID that was already cached before a new start', async () => {
    const h = harness();
    writeConversationCache(h.home, { [realpathSync(h.workspace)]: START_CONVERSATION });

    await expect(collect(h.adapter.start(request({ workspace: h.workspace })))).resolves.toEqual([{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'Antigravity provider protocol error',
      nativeStateAdvanced: true,
    }]);
  });

  it('caps aggregate stdout at 1 MiB and does not expose it', async () => {
    const h = harness('oversized');
    const events = await collect(h.adapter.resume({
      ...request({ workspace: h.workspace }),
      nativeSessionId: RESUME_CONVERSATION,
    }));

    expect(events).toEqual([{
      type: 'failed',
      code: 'adapter_protocol_error',
      message: 'Antigravity provider protocol error',
      nativeStateAdvanced: true,
    }]);
    expect(JSON.stringify(events)).not.toContain('xxxx');
  });

  it('bridges client tools through a strict Gateway JSON prompt without registering native tools', async () => {
    const h = harness();
    const outputSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { const: 'assistant_text' },
        content: { type: 'string' },
      },
      required: ['type', 'content'],
    };
    const providerRequest = request({
      workspace: h.workspace,
      outputSchema,
    });

    const events = await collect(h.adapter.start(providerRequest));
    const args = h.records().find((entry) => entry.kind === 'invocation')?.args ?? [];
    const prompt = args.at(-1) ?? '';

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: START_CONVERSATION },
      { type: 'structured_delta', delta: '{"type":"assistant_text","content":"final answer"}' },
      { type: 'completed' },
    ]);
    expect(args).not.toContain('--tools');
    expect(prompt).toBe(renderAntigravityPrompt(providerRequest));
    expect(prompt).toContain(JSON.stringify(outputSchema));
    expect(prompt).not.toContain('<gateway_policy>');
    expect(prompt).not.toContain('You are responding through Agent Squad Gateway');
    expect(prompt.lastIndexOf('do not execute it or use native tools.'))
      .toBeGreaterThan(prompt.indexOf('Required response schema:'));
  });

  it('normalizes nonzero exits without exposing stderr diagnostics', async () => {
    const h = harness('nonzero');
    const events = await collect(h.adapter.start(request({ workspace: h.workspace })));

    expect(events).toEqual([{
      type: 'failed',
      code: 'adapter_process_error',
      message: 'Antigravity provider process error',
      nativeStateAdvanced: true,
    }]);
    expect(JSON.stringify(events)).not.toMatch(/Sensitive|secret-token|credential/);
  });

  it('reports a pre-start spawn failure without advancing native state', async () => {
    const spawn: SpawnManagedProcess = () => {
      throw Object.assign(new Error('sensitive spawn path'), { code: 'adapter_spawn_failed' });
    };
    const adapter = new AntigravityProviderAdapter({ spawnProcess: spawn });

    await expect(collect(adapter.start(request()))).resolves.toEqual([{
      type: 'failed',
      code: 'adapter_spawn_failed',
      message: 'Antigravity provider process error',
      nativeStateAdvanced: false,
    }]);
  });

  it('interrupts the process when the request signal aborts', async () => {
    const h = harness('cancel');
    const controller = new AbortController();
    const pending = collect(h.adapter.start(request({
      workspace: h.workspace,
      signal: controller.signal,
    })));
    await waitFor(
      () => h.records().some((entry) => entry.kind === 'invocation'),
      'Antigravity invocation',
    );
    controller.abort();

    await expect(pending).resolves.toEqual([{ type: 'cancelled' }]);
    await waitFor(
      () => h.records().some((entry) => entry.kind === 'signal'),
      'Antigravity SIGINT record',
    );
    expect(h.records()).toContainEqual({ kind: 'signal', signal: 'SIGINT' });
  });

  it('statically probes only version, help, and models with conservative claims', async () => {
    const h = harness();
    const capabilities = await h.adapter.probeCapabilities({ mode: 'static' });

    expect(capabilities).toEqual({
      available: true,
      version: '1.1.1',
      verified: false,
      modelSelection: true,
      effortSelection: false,
      modelOptions: [
        { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)', effortOptions: null },
        { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)', effortOptions: null },
      ],
      isolationLevel: 'best_effort',
      streamingMode: 'none',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
      details: [ANTIGRAVITY_ARGV_WARNING, ANTIGRAVITY_TOOL_BRIDGE_WARNING],
    });
    expect(h.specs.map((spec) => [spec.command, spec.args])).toEqual([
      ['agy', ['--version']],
      ['agy', ['--help']],
      ['agy', ['models']],
    ]);
    expect(h.records().filter((entry) => entry.kind === 'invocation')).toHaveLength(0);
  });

  it('conformance verifies the Gateway JSON bridge on both start and resume', async () => {
    const h = harness();
    const capabilities = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'antigravity-test',
      model: 'Gemini 3.5 Flash (High)',
      effort: null,
      workspace: h.workspace,
      signal: new AbortController().signal,
    });

    expect(capabilities).toMatchObject({
      available: true,
      verified: true,
      isolationLevel: 'best_effort',
      streamingMode: 'none',
      toolBridge: 'structured_output',
    });
    expect(Date.parse(capabilities.verifiedAt ?? '')).not.toBeNaN();
    const invocations = h.records().filter((entry) => entry.kind === 'invocation');
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).not.toContain('--conversation');
    expect(invocations[1]?.args).toContain('--conversation');
    expect(invocations.every((entry) => entry.args?.at(-2) === '--print')).toBe(true);
    expect(invocations.every((entry) => entry.args?.at(-1)?.includes('Required response schema:')))
      .toBe(true);
  });
});
