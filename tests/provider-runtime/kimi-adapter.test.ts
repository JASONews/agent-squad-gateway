import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  KIMI_ISOLATION_WARNING,
  KIMI_SESSION_RETENTION_WARNING,
  KimiProviderAdapter,
} from '../../src/provider-runtime/kimi/adapter.js';
import { providerSupportsImageInput } from '../../src/provider-runtime/image-support.js';
import { API_PROVIDER_SYSTEM_INSTRUCTION } from '../../src/provider-runtime/provider-input.js';
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

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/fake-clis/kimi.mjs');
const OUTPUT_SCHEMA = {
  required: ['content', 'type'],
  type: 'object',
  properties: {
    content: { type: 'string' },
    type: { const: 'assistant_text' },
  },
  additionalProperties: false,
};

interface RecordEntry {
  kind: 'invocation' | 'message' | 'signal';
  args?: string[];
  cwd?: string;
  message?: Record<string, unknown>;
  signal?: string;
}

interface Harness {
  adapter: KimiProviderAdapter;
  workspace: string;
  specs: ManagedProcessSpec[];
  records(): RecordEntry[];
  messages(method?: string): Array<Record<string, unknown>>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function harness(
  scenario = 'text',
  options: { staticProbeTimeoutMs?: number } = {},
): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'asq-kimi-adapter-'));
  const recordPath = join(workspace, 'records.jsonl');
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
        FAKE_KIMI_SCENARIO: scenario,
        FAKE_KIMI_RECORD: recordPath,
      },
    });
    processes.add(managed);
    void managed.exited.finally(() => processes.delete(managed)).catch(() => undefined);
    return managed;
  };
  const adapter = new KimiProviderAdapter({ spawnProcess: spawn, ...options });
  cleanups.push(async () => {
    await Promise.allSettled([...processes].map((process) => process.dispose()));
    rmSync(workspace, { recursive: true, force: true });
  });

  const records = (): RecordEntry[] => {
    try {
      return readFileSync(recordPath, 'utf8').trim().split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordEntry);
    } catch {
      return [];
    }
  };
  return {
    adapter,
    workspace,
    specs,
    records,
    messages(method) {
      return records()
        .filter((entry) => entry.kind === 'message' && entry.message)
        .map((entry) => entry.message!)
        .filter((message) => method === undefined || message.method === method);
    },
  };
}

function request(h: Harness, overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'kimi-default',
    model: 'default',
    effort: null,
    workspace: h.workspace,
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

describe('KimiProviderAdapter', () => {
  it('performs a static version/help probe without starting ACP or using a model', async () => {
    const h = harness();

    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toMatchObject({
      available: true,
      version: '0.24.1',
      verified: false,
      isolationLevel: 'best_effort',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      modelOptions: [{
        id: 'default',
        label: 'Kimi Code default',
        effortOptions: ['off', 'on'],
      }],
      details: [KIMI_ISOLATION_WARNING, KIMI_SESSION_RETENTION_WARNING],
    });
    expect(h.specs.map((spec) => spec.args)).toEqual([['--version'], ['--help']]);
    expect(h.specs.some((spec) => spec.args[0] === 'acp')).toBe(false);
  });

  it('bounds static probes when the executable hangs', async () => {
    const h = harness('probe-hang', { staticProbeTimeoutMs: 50 });
    const startedAt = Date.now();

    await expect(h.adapter.probeCapabilities({ mode: 'static' })).resolves.toMatchObject({
      available: false,
      verified: false,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('streams native ACP message chunks with an isolated session request', async () => {
    const h = harness();
    const providerRequest = request(h, { sessionMode: 'persistent' });

    await expect(collect(h.adapter.start(providerRequest))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      { type: 'text_delta', delta: 'Hello f' },
      { type: 'text_delta', delta: 'rom Kimi' },
      { type: 'completed' },
    ]);

    expect(h.specs).toEqual([expect.objectContaining({
      command: 'kimi',
      args: ['acp'],
      cwd: h.workspace,
    })]);
    const initialize = h.messages('initialize')[0]!;
    expect(initialize.params).toEqual(expect.objectContaining({
      clientCapabilities: { session: { configOptions: {} } },
    }));
    expect(JSON.stringify(initialize.params)).not.toContain('terminal');
    expect(JSON.stringify(initialize.params)).not.toContain('fs');
    expect(h.messages('session/new')[0]?.params).toEqual({
      cwd: h.workspace,
      mcpServers: [],
    });
    expect(h.messages('session/set_config_option')).toHaveLength(0);
    const prompt = h.messages('session/prompt')[0]?.params as {
      prompt: Array<{ type: string; text?: string }>;
    };
    expect(prompt.prompt[0]?.text).toMatch(new RegExp(`^${API_PROVIDER_SYSTEM_INSTRUCTION}`));
    expect(h.messages('session/delete')).toHaveLength(0);
  });

  it('resumes the exact session and sets custom model and thinking config options', async () => {
    const h = harness();
    const resumed = request(h, {
      runId: 'run_resume',
      model: 'custom-kimi-model',
      effort: 'high',
      sessionMode: 'persistent',
    });

    await expect(collect(h.adapter.resume({
      ...resumed,
      nativeSessionId: 'kimi-existing-session',
    } satisfies ProviderResumeRequest))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-existing-session' },
      { type: 'text_delta', delta: 'Hello f' },
      { type: 'text_delta', delta: 'rom Kimi' },
      { type: 'completed' },
    ]);

    expect(h.messages('session/resume')[0]?.params).toEqual({
      sessionId: 'kimi-existing-session',
      cwd: h.workspace,
      mcpServers: [],
    });
    expect(h.messages('session/set_config_option').map((message) => message.params)).toEqual([
      { sessionId: 'kimi-existing-session', configId: 'model', value: 'custom-kimi-model' },
      { sessionId: 'kimi-existing-session', configId: 'thinking', value: 'on' },
    ]);
  });

  it('sends images as native ACP base64 blocks and streams schema output deterministically', async () => {
    const h = harness();
    const imagePath = join(h.workspace, 'image.png');
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(imagePath, image);

    const events = await collect(h.adapter.start(request(h, {
      outputSchema: OUTPUT_SCHEMA,
      images: [{ path: imagePath, mediaType: 'image/png', detail: 'auto' }],
    })));

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      { type: 'structured_delta', delta: '{"type":"assistant_text"' },
      { type: 'structured_delta', delta: ',"content":"Confirmed."}' },
      { type: 'completed' },
    ]);
    const params = h.messages('session/prompt')[0]?.params as {
      prompt: Array<Record<string, unknown>>;
    };
    expect(params.prompt[0]?.text).toContain(
      'JSON Schema: {"additionalProperties":false,"properties":{"content":{"type":"string"},"type":{"const":"assistant_text"}},"required":["content","type"],"type":"object"}',
    );
    expect(params.prompt[1]).toEqual({
      type: 'image',
      data: image.toString('base64'),
      mimeType: 'image/png',
    });
    expect(providerSupportsImageInput('kimi')).toBe(true);
    expect(h.messages('session/delete')).toHaveLength(0);
  });

  it('rejects every ACP permission request', async () => {
    const h = harness('permission');

    await expect(collect(h.adapter.start(request(h)))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      { type: 'text_delta', delta: 'Permission re' },
      { type: 'text_delta', delta: 'jected safely.' },
      { type: 'completed' },
    ]);
    const response = h.messages().find((message) => message.id === 'permission-1');
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    });
  });

  it.each(['tool', 'tool-update'])('fails closed when Kimi reports an ACP %s', async (scenario) => {
    const h = harness(scenario);

    await expect(collect(h.adapter.start(request(h)))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      {
        type: 'failed',
        code: 'adapter_protocol_error',
        message: 'Kimi provider protocol error',
        nativeStateAdvanced: true,
      },
    ]);
    expect(h.messages('session/cancel')).toHaveLength(1);
  });

  it('sends ACP cancellation and terminates the subprocess', async () => {
    const h = harness('cancel');
    const events = collect(h.adapter.start(request(h, { runId: 'run_cancel' })));
    await waitFor(() => h.messages('session/prompt').length === 1, 'Kimi prompt');

    await h.adapter.cancel('run_cancel');

    await expect(events).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      { type: 'cancelled' },
    ]);
    expect(h.messages('session/cancel')).toHaveLength(1);
  });

  it('reports a subprocess crash without exposing bounded stderr diagnostics', async () => {
    const h = harness('crash');

    const events = await collect(h.adapter.start(request(h)));

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'kimi-session-1' },
      {
        type: 'failed',
        code: 'adapter_process_error',
        message: 'Kimi provider process error',
        nativeStateAdvanced: true,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('Sensitive Kimi diagnostic');
  });

  it.each(['refusal', 'max_tokens', 'max_turn_requests']) (
    'fails a prompt that stops with %s',
    async (scenario) => {
      const h = harness(scenario);
      const events = await collect(h.adapter.start(request(h)));

      expect(events.at(-1)).toEqual({
        type: 'failed',
        code: 'adapter_protocol_error',
        message: 'Kimi provider protocol error',
        nativeStateAdvanced: true,
      });
      expect(events).not.toContainEqual({ type: 'completed' });
    },
  );

  it('conformance verifies incremental structured output and session resume', async () => {
    const h = harness();

    const result = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'kimi-k2-high',
      model: 'kimi-k2.5',
      effort: 'high',
      workspace: h.workspace,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      available: true,
      version: '0.24.1',
      verified: true,
      verifiedAt: expect.any(String),
      isolationLevel: 'best_effort',
      modelOptions: [
        {
          id: 'default',
          label: 'Kimi Code default',
          effortOptions: null,
        },
        {
          id: 'kimi-k2.5',
          label: 'Kimi K2.5',
          effortOptions: ['off', 'on'],
        },
        {
          id: 'kimi-k2-thinking',
          label: 'Kimi K2 Thinking',
          effortOptions: null,
        },
      ],
    });
    expect(Number.isNaN(Date.parse(result.verifiedAt!))).toBe(false);
    expect(h.messages('session/new')).toHaveLength(1);
    expect(h.messages('session/resume')).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ sessionId: 'kimi-session-1', mcpServers: [] }),
      }),
    ]);
    expect(h.messages('session/prompt')).toHaveLength(2);
  });

  it('accepts valid single-chunk ACP output during conformance', async () => {
    const h = harness('single-chunk');
    const result = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'kimi-single-chunk',
      model: 'kimi-k2.5',
      effort: 'on',
      workspace: h.workspace,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ available: true, verified: true });
  });

  it('requires Kimi to advertise image input before conformance succeeds', async () => {
    const h = harness('no-image-capability');
    const result = await h.adapter.probeCapabilities({
      mode: 'conformance',
      targetId: 'kimi-no-image',
      model: 'default',
      effort: null,
      workspace: h.workspace,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      available: false,
      verified: false,
      error: 'adapter_capability_unsupported',
    });
  });
});
