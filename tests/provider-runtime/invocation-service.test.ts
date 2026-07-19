import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import {
  InvocationService,
  type InvocationRequest,
} from '../../src/provider-runtime/invocation-service.js';
import type { ImageAssetMaterializerLike } from '../../src/provider-runtime/image-assets.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest,
  ProviderResumeRequest,
} from '../../src/provider-runtime/types.js';

let db: GatewayDb | undefined;

afterEach(() => db?.close());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function target(overrides: Partial<InvocationTarget> = {}): InvocationTarget {
  return {
    id: 'target-a',
    aliases: [],
    cli: 'fake',
    nativeModel: 'fake-model',
    reasoningEffort: null,
    enabled: true,
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 1_000,
    runTimeoutMs: null,
    fixedWorkspace: null,
    capabilityVersion: '1.0.0',
    capabilityVerifiedAt: '2026-07-11T00:00:00.000Z',
    capabilities: {
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      modelSelection: true,
      effortSelection: true,
      resume: true,
      cancellation: true,
    },
    capabilityError: null,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    extensionId: 'openai',
    targetId: 'target-a',
    endpoint: '/v1/chat/completions',
    input: [{ role: 'user', content: 'secret request text' }],
    sessionMode: 'ephemeral',
    outputSchema: null,
    ...overrides,
  };
}

function adapterFrom(
  stream: (request: ProviderRequest | ProviderResumeRequest, attempt: number) => AsyncIterable<unknown>,
) {
  let attempts = 0;
  const adapter: ProviderAdapter = {
    probeCapabilities: vi.fn(async () => ({
      available: true,
      verified: true,
      modelSelection: true,
      effortSelection: true,
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
    })),
    start: vi.fn((providerRequest) => stream(providerRequest, attempts++)) as ProviderAdapter['start'],
    resume: vi.fn((providerRequest) => stream(providerRequest, attempts++)) as ProviderAdapter['resume'],
    cancel: vi.fn(async () => undefined),
  };
  return adapter;
}

function sequence(events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function harness(
  adapter: ProviderAdapter,
  invocationTarget = target(),
  imageAssets?: ImageAssetMaterializerLike,
) {
  db = openGatewayDb(':memory:');
  const runs = new RunRepository(db);
  const registry = new ProviderRegistry();
  registry.register(invocationTarget.cli, adapter);
  const release = vi.fn(async () => undefined);
  const workspaces = {
    acquireChat: vi.fn(async () => ({ path: '/safe/chat', release })),
    createResponse: vi.fn(async () => ({ path: '/safe/response', release })),
    openResponse: vi.fn(async () => ({ path: '/safe/existing', release })),
  };
  const service = new InvocationService(
    registry,
    new TargetScheduler(),
    workspaces,
    { get: vi.fn(() => invocationTarget) },
    runs,
    imageAssets,
  );
  return { service, runs, workspaces, release };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const result: ProviderEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('InvocationService', () => {
  it('runs against the externally reserved Run row', async () => {
    const adapter = adapterFrom(() => sequence([
      { type: 'session_started', nativeSessionId: 'native-1' },
      { type: 'completed' },
    ]));
    const { service, runs } = harness(adapter);
    const run = runs.create({
      extensionId: 'openai',
      targetId: 'target-a',
      endpoint: '/v1/chat/completions',
    });

    await expect(collect(service.invoke(request({ runId: run.id })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'native-1' },
      { type: 'completed' },
    ]);
    expect(adapter.start).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }));
    expect(runs.list()).toEqual([expect.objectContaining({ id: run.id, status: 'completed' })]);
  });

  it('rejects a reserved Run whose metadata does not match the invocation', async () => {
    const adapter = adapterFrom(() => sequence([
      { type: 'session_started', nativeSessionId: 'native-1' },
      { type: 'completed' },
    ]));
    const { service, runs } = harness(adapter);
    const reserved = runs.create({
      extensionId: 'openai',
      targetId: 'different-target',
      endpoint: '/v1/chat/completions',
    });

    await expect(collect(service.invoke(request({ runId: reserved.id })))).rejects.toThrow('reserved_run_mismatch');
    expect(adapter.start).not.toHaveBeenCalled();
    expect(runs.list()).toHaveLength(1);
  });

  it.each([
    ['disabled', target({ enabled: false }), 'target_disabled'],
    ['unverified', target({ capabilityVerifiedAt: null }), 'capability_mismatch'],
    [
      'incompatible',
      target({ capabilities: { ...target().capabilities!, streamingMode: 'none' } }),
      'capability_mismatch',
    ],
  ])('rejects a %s target before creating a Run', async (_name, configuredTarget, code) => {
    const adapter = adapterFrom(() => sequence([]));
    const { service, runs } = harness(adapter, configuredTarget);

    await expect(collect(service.invoke(request()))).rejects.toThrow(code);
    expect(runs.list()).toEqual([]);
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it('uses ephemeral Chat and persistent Responses workspaces and records lifecycle metadata only', async () => {
    const adapter = adapterFrom((_providerRequest, attempt) => sequence([
      { type: 'session_started', nativeSessionId: `native-${attempt}` },
      { type: 'text_delta', delta: 'secret output text' },
      { type: 'completed' },
    ]));
    const { service, runs, workspaces } = harness(adapter);

    await expect(collect(service.invoke(request()))).resolves.toHaveLength(3);
    await expect(collect(service.invoke(request({
      endpoint: '/v1/responses',
      responseId: 'resp-1',
      sessionMode: 'persistent',
    })))).resolves.toHaveLength(3);

    expect(workspaces.acquireChat).toHaveBeenCalledOnce();
    expect(workspaces.createResponse).toHaveBeenCalledOnce();
    expect(adapter.start).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionMode: 'ephemeral', workspace: '/safe/chat',
    }));
    expect(adapter.start).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionMode: 'persistent', workspace: '/safe/response',
    }));
    expect(runs.list()).toEqual([
      expect.objectContaining({ status: 'completed', nativeSessionId: 'native-1', latencyMs: expect.any(Number) }),
      expect.objectContaining({ status: 'completed', nativeSessionId: 'native-0', latencyMs: expect.any(Number) }),
    ]);
    const columns = db!.prepare<[], { name: string }>('PRAGMA table_info(runs)').all().map(({ name }) => name);
    expect(columns).not.toEqual(expect.arrayContaining(['prompt', 'completion', 'tool_payload', 'raw_event']));
  });

  it('materializes image references before provider start and releases them before the terminal event', async () => {
    const order: string[] = [];
    const adapter = adapterFrom((providerRequest) => {
      order.push('provider');
      expect(providerRequest.images).toEqual([{
        path: '/private/tmp/staged.png',
        mediaType: 'image/png',
        detail: 'high',
      }]);
      return sequence([
        { type: 'session_started', nativeSessionId: 'native-image' },
        { type: 'completed' },
      ]);
    });
    const imageRelease = vi.fn(async () => { order.push('image-release'); });
    const imageAssets: ImageAssetMaterializerLike = {
      materialize: vi.fn(async () => ({
        images: [{
          path: '/private/tmp/staged.png',
          mediaType: 'image/png',
          detail: 'high',
        }],
        release: imageRelease,
      })),
    };
    const { service } = harness(adapter, target({ cli: 'codex' }), imageAssets);
    const iterator = service.invoke(request({
      images: [{ url: 'data:image/png;base64,abc', detail: 'high' }],
    }))[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'completed' } });
    order.push('terminal');

    expect(imageAssets.materialize).toHaveBeenCalledWith(
      [{ url: 'data:image/png;base64,abc', detail: 'high' }],
      expect.any(AbortSignal),
    );
    expect(imageRelease).toHaveBeenCalledOnce();
    expect(order).toEqual(['provider', 'image-release', 'terminal']);
  });

  it('rejects image input before adapter start when the provider has no native image channel', async () => {
    const adapter = adapterFrom(() => sequence([]));
    const imageAssets: ImageAssetMaterializerLike = { materialize: vi.fn() };
    const { service, runs } = harness(adapter, target({ cli: 'cursor' }), imageAssets);

    await expect(collect(service.invoke(request({
      images: [{ url: 'https://example.com/image.png', detail: 'auto' }],
    })))).resolves.toEqual([{
      type: 'failed',
      code: 'image_input_not_supported',
      message: 'Provider invocation failed',
      nativeStateAdvanced: false,
    }]);
    expect(adapter.start).not.toHaveBeenCalled();
    expect(imageAssets.materialize).not.toHaveBeenCalled();
    expect(runs.list()[0]).toMatchObject({ status: 'failed', errorCode: 'image_input_not_supported' });
  });

  it('opens a persistent response workspace and resumes its native session', async () => {
    const adapter = adapterFrom(() => sequence([
      { type: 'session_started', nativeSessionId: 'native-parent' },
      { type: 'completed' },
    ]));
    const { service, workspaces } = harness(adapter);

    await collect(service.invoke(request({
      endpoint: '/v1/responses',
      responseId: 'resp-child',
      sessionMode: 'persistent',
      nativeSessionId: 'native-parent',
      workspacePath: '/managed/parent',
    })));

    expect(workspaces.openResponse).toHaveBeenCalledWith('/managed/parent');
    expect(adapter.resume).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionId: 'native-parent', sessionMode: 'persistent', workspace: '/safe/existing',
    }));
  });

  it('delivers deltas incrementally while retaining the scheduler slot for provider iteration', async () => {
    const continueFirst = deferred<void>();
    const starts: string[] = [];
    const adapter = adapterFrom((providerRequest) => (async function* () {
      starts.push(providerRequest.runId);
      yield { type: 'session_started', nativeSessionId: providerRequest.runId };
      yield { type: 'text_delta', delta: 'first' };
      await continueFirst.promise;
      yield { type: 'completed' };
    })());
    const { service } = harness(adapter);
    const first = service.invoke(request())[Symbol.asyncIterator]();

    await first.next();
    await expect(first.next()).resolves.toEqual({ done: false, value: { type: 'text_delta', delta: 'first' } });
    const second = service.invoke(request())[Symbol.asyncIterator]();
    const secondStarted = second.next();
    await Promise.resolve();
    expect(starts).toHaveLength(1);

    continueFirst.resolve();
    await first.next();
    await expect(secondStarted).resolves.toMatchObject({ value: { type: 'session_started' } });
    await second.return?.();
  });

  it('commits and cleans up before exposing a terminal event', async () => {
    const order: string[] = [];
    const adapter = adapterFrom(() => sequence([
      { type: 'session_started', nativeSessionId: 'native-order' },
      { type: 'completed' },
    ]));
    const { service, runs, release } = harness(adapter);
    release.mockImplementation(async () => { order.push('release'); });
    const markFinished = vi.spyOn(runs, 'markFinished').mockImplementation((...args) => {
      order.push('finish');
      return RunRepository.prototype.markFinished.apply(runs, args);
    });
    const iterator = service.invoke(request())[Symbol.asyncIterator]();

    await iterator.next();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'completed' } });
    order.push('exposed');

    expect(order).toEqual(['release', 'finish', 'exposed']);
    expect(markFinished).toHaveBeenCalledWith(expect.any(String), 'completed', undefined);
    expect(runs.list()[0]).toMatchObject({ status: 'completed' });
  });

  it.each([
    [{ type: 'failed', code: 'provider_failed', message: 'safe', nativeStateAdvanced: false }, 'failed', 'provider_failed'],
    [{ type: 'cancelled' }, 'cancelled', null],
  ])('maps provider terminal event %# to Run state', async (terminal, status, errorCode) => {
    const adapter = adapterFrom(() => sequence([terminal]));
    const { service, runs, release } = harness(adapter);

    await expect(collect(service.invoke(request()))).resolves.toEqual([terminal]);
    expect(runs.list()[0]).toMatchObject({ status, errorCode });
    expect(release).toHaveBeenCalledOnce();
  });

  it('retries exactly once only for the enumerated pre-session spawn failure', async () => {
    const adapter = adapterFrom((_request, attempt) => attempt === 0
      ? sequence([{ type: 'failed', code: 'provider_spawn_failed', message: 'spawn', nativeStateAdvanced: false }])
      : sequence([
        { type: 'session_started', nativeSessionId: 'native-retry' },
        { type: 'completed' },
      ]));
    const { service, runs } = harness(adapter);

    await expect(collect(service.invoke(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'native-retry' },
      { type: 'completed' },
    ]);
    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(runs.list()[0]).toMatchObject({ status: 'completed', nativeSessionId: 'native-retry' });
  });

  it.each([
    ['unlisted failure', [{ type: 'failed', code: 'other', message: 'x', nativeStateAdvanced: false }]],
    ['advanced state', [{ type: 'failed', code: 'provider_spawn_failed', message: 'x', nativeStateAdvanced: true }]],
    ['started session', [
      { type: 'session_started', nativeSessionId: 'native-no-retry' },
      { type: 'failed', code: 'provider_spawn_failed', message: 'x', nativeStateAdvanced: false },
    ]],
  ])('does not retry after %s', async (_name, events) => {
    const adapter = adapterFrom(() => sequence(events));
    const { service } = harness(adapter);

    await collect(service.invoke(request()));
    expect(adapter.start).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown', [{ type: 'mystery', payload: 'secret' }]],
    ['malformed', [{ type: 'text_delta', delta: 42 }]],
    ['missing terminal', [{ type: 'session_started', nativeSessionId: 'native' }]],
    ['post terminal', [{ type: 'completed' }, { type: 'text_delta', delta: 'late' }]],
    ['second terminal', [{ type: 'completed' }, { type: 'cancelled' }]],
  ])('turns %s adapter output into adapter_protocol_error', async (_name, events) => {
    const adapter = adapterFrom(() => sequence(events));
    const { service, runs } = harness(adapter);

    const result = await collect(service.invoke(request()));

    expect(result.at(-1)).toMatchObject({ type: 'failed', code: 'adapter_protocol_error' });
    expect(runs.list()[0]).toMatchObject({ status: 'failed', errorCode: 'adapter_protocol_error' });
  });

  it('maps a thrown adapter operation to a sanitized failed terminal', async () => {
    const adapter = adapterFrom(() => (async function* () {
      throw new Error('secret provider output');
    })());
    const { service, runs } = harness(adapter);

    await expect(collect(service.invoke(request()))).resolves.toEqual([
      { type: 'failed', code: 'provider_unavailable', message: 'Provider invocation failed', nativeStateAdvanced: false },
    ]);
    expect(runs.list()[0]).toMatchObject({ status: 'failed', errorCode: 'provider_unavailable' });
  });

  it('turns workspace release failure into failure after still releasing the scheduler slot', async () => {
    const adapter = adapterFrom(() => sequence([{ type: 'completed' }]));
    const { service, runs, release } = harness(adapter);
    release.mockRejectedValueOnce(new Error('secret cleanup path'));

    await expect(collect(service.invoke(request()))).resolves.toEqual([
      { type: 'failed', code: 'workspace_cleanup_error', message: 'Workspace cleanup failed', nativeStateAdvanced: false },
    ]);
    expect(runs.list()[0]).toMatchObject({ status: 'failed', errorCode: 'workspace_cleanup_error' });
    await expect(collect(service.invoke(request()))).resolves.toEqual([{ type: 'completed' }]);
  });

  it('aborts provider work, invokes adapter cancellation, and releases on consumer return', async () => {
    const providerStopped = deferred<void>();
    const adapter = adapterFrom((providerRequest) => (async function* () {
      try {
        yield { type: 'session_started', nativeSessionId: 'native-early' };
        await new Promise<void>((resolve) => providerRequest.signal.addEventListener('abort', () => resolve(), { once: true }));
        yield { type: 'cancelled' };
      } finally {
        providerStopped.resolve();
      }
    })());
    const { service, runs, release } = harness(adapter);
    const iterator = service.invoke(request())[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.return?.();
    await providerStopped.promise;

    expect(adapter.cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(runs.list()[0]).toMatchObject({ status: 'cancelled' });
  });

  it('returns out of band while queued next is pending without starting the adapter', async () => {
    const unblockActive = deferred<void>();
    const adapter = adapterFrom((_providerRequest, attempt) => (async function* () {
      yield { type: 'session_started', nativeSessionId: `native-${attempt}` };
      if (attempt === 0) await unblockActive.promise;
      yield { type: 'completed' };
    })());
    const { service, runs } = harness(adapter);
    const active = service.invoke(request())[Symbol.asyncIterator]();
    await active.next();
    const queued = service.invoke(request())[Symbol.asyncIterator]();
    const queuedNext = queued.next();
    await Promise.resolve();

    const queuedReturn = queued.return!();
    unblockActive.resolve();
    await active.next();

    await expect(queuedReturn).resolves.toEqual({ done: true, value: undefined });
    await expect(queuedNext).resolves.toEqual({ done: true, value: undefined });
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(runs.list().find((run) => run.startedAt === null)).toMatchObject({ status: 'cancelled' });
  });

  it('returns out of band while active next is pending and releases resources before another provider event', async () => {
    const providerGate = deferred<void>();
    const adapter = adapterFrom(() => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-pending-return' };
      await providerGate.promise;
      yield { type: 'completed' };
    })());
    const { service, runs, release } = harness(adapter);
    const iterator = service.invoke(request())[Symbol.asyncIterator]();
    await iterator.next();
    const pendingNext = iterator.next();

    const returning = iterator.return!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const releasedBeforeProviderYield = release.mock.calls.length;
    providerGate.resolve();

    await expect(returning).resolves.toEqual({ done: true, value: undefined });
    await expect(pendingNext).resolves.toEqual({ done: true, value: undefined });
    expect(releasedBeforeProviderYield).toBe(1);
    expect(adapter.cancel).toHaveBeenCalledOnce();
    expect(runs.list()[0]).toMatchObject({ status: 'cancelled' });
  });

  it.each([
    { type: 'completed' } as const,
    { type: 'failed', code: 'provider_failed', message: 'safe', nativeStateAdvanced: true } as const,
  ])('keeps cancellation authoritative over a racing $type terminal', async (terminal) => {
    const providerGate = deferred<void>();
    const adapter = adapterFrom(() => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-terminal-race' };
      await providerGate.promise;
      yield terminal;
    })());
    const { service, runs } = harness(adapter);
    const iterator = service.invoke(request())[Symbol.asyncIterator]();
    await iterator.next();
    const pendingNext = iterator.next();
    const runId = runs.list()[0]!.id;

    const cancelling = service.cancel(runId);
    providerGate.resolve();

    await expect(cancelling).resolves.toBe(true);
    await expect(pendingNext).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(runs.list()[0]).toMatchObject({ status: 'cancelled', errorCode: null });
  });

  it('keeps timeout authoritative over a racing completed terminal', async () => {
    vi.useFakeTimers();
    const providerGate = deferred<void>();
    const adapter = adapterFrom(() => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-timeout-race' };
      await providerGate.promise;
      yield { type: 'completed' };
    })());
    const { service, runs } = harness(adapter, target({ runTimeoutMs: 10 }));
    const iterator = service.invoke(request())[Symbol.asyncIterator]();

    try {
      await iterator.next();
      const pendingNext = iterator.next();
      await vi.advanceTimersByTimeAsync(10);
      providerGate.resolve();

      await expect(pendingNext).resolves.toEqual({
        done: false,
        value: {
          type: 'failed',
          code: 'provider_timeout',
          message: 'Provider invocation timed out',
          nativeStateAdvanced: true,
        },
      });
      expect(runs.list()[0]).toMatchObject({ status: 'failed', errorCode: 'provider_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an active Run deterministically when native cancellation throws', async () => {
    const adapter = adapterFrom((providerRequest) => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-active-cancel' };
      await new Promise<void>((resolve) => providerRequest.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'cancelled' };
    })());
    vi.mocked(adapter.cancel).mockRejectedValueOnce(new Error('native cancellation failed'));
    const { service, runs, release } = harness(adapter);
    const iterator = service.invoke(request())[Symbol.asyncIterator]();
    await iterator.next();
    const runId = runs.list()[0]!.id;

    await expect(service.cancel(runId)).resolves.toBe(true);
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await iterator.return?.();

    expect(adapter.cancel).toHaveBeenCalledWith(runId);
    expect(release).toHaveBeenCalledOnce();
    expect(runs.list()[0]).toMatchObject({ status: 'cancelled' });
    await expect(service.cancel(runId)).resolves.toBe(false);
  });

  it('aborts every active and queued Run during Gateway shutdown', async () => {
    const adapter = adapterFrom((providerRequest) => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-shutdown' };
      await new Promise<void>((resolve) => {
        providerRequest.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'cancelled' };
    })());
    const { service, runs } = harness(adapter);
    const active = service.invoke(request())[Symbol.asyncIterator]();
    await active.next();
    const queued = service.invoke(request())[Symbol.asyncIterator]();
    const queuedNext = queued.next();
    await Promise.resolve();

    await service.abortActive();

    await expect(active.next()).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await expect(queuedNext).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(runs.list().map((run) => run.status)).toEqual(['cancelled', 'cancelled']);
    expect(adapter.cancel).toHaveBeenCalledOnce();
  });

  it('keeps an aborted Run cancelled when workspace release also fails', async () => {
    const adapter = adapterFrom((providerRequest) => (async function* () {
      yield { type: 'session_started', nativeSessionId: 'native-cancel-cleanup' };
      await new Promise<void>((resolve) => providerRequest.signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'cancelled' };
    })());
    const { service, runs, release } = harness(adapter);
    release.mockRejectedValueOnce(new Error('workspace release failed'));
    const iterator = service.invoke(request())[Symbol.asyncIterator]();
    await iterator.next();

    await iterator.return?.();

    expect(release).toHaveBeenCalledOnce();
    expect(runs.list()[0]).toMatchObject({ status: 'cancelled', errorCode: null });
  });

  it('cancels queued work without starting its adapter and frees it for later work', async () => {
    const unblock = deferred<void>();
    const adapter = adapterFrom((providerRequest, attempt) => (async function* () {
      yield { type: 'session_started', nativeSessionId: `native-${attempt}` };
      if (attempt === 0) await unblock.promise;
      yield { type: 'completed' };
    })());
    const { service, runs } = harness(adapter);
    const active = service.invoke(request())[Symbol.asyncIterator]();
    await active.next();
    const queued = service.invoke(request())[Symbol.asyncIterator]();
    const queuedNext = queued.next();
    await Promise.resolve();
    const queuedRun = runs.list().find((run) => run.status === 'queued')!;

    await expect(service.cancel(queuedRun.id)).resolves.toBe(true);
    await expect(queuedNext).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    expect(adapter.start).toHaveBeenCalledOnce();
    expect(runs.list().find((run) => run.id === queuedRun.id)).toMatchObject({ status: 'cancelled', startedAt: null });

    unblock.resolve();
    await active.next();
    await expect(collect(service.invoke(request()))).resolves.toMatchObject([
      { type: 'session_started' }, { type: 'completed' },
    ]);
  });
});
