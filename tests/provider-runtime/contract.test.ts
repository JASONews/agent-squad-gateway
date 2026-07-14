import { describe, expect, it, vi } from 'vitest';
import { FakeProviderAdapter } from '../../src/provider-runtime/fake/adapter.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import type { ProviderEvent, ProviderRequest } from '../../src/provider-runtime/types.js';

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    runId: 'run_1',
    targetId: 'fake-text',
    model: 'fake',
    effort: null,
    workspace: '/tmp/empty',
    input: [{ role: 'user', content: 'hi' }],
    sessionMode: 'ephemeral',
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

function watchAbortCleanup(controller = new AbortController()) {
  return {
    controller,
    removeEventListener: vi.spyOn(controller.signal, 'removeEventListener'),
  };
}

describe('provider runtime contract', () => {
  it('streams only normalized safe text events', async () => {
    const registry = new ProviderRegistry();
    registry.register('fake', new FakeProviderAdapter({ chunks: ['hel', 'lo'] }));
    const events = await collect(registry.require('fake').start(request()));

    expect(events).toEqual([
      { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      { type: 'text_delta', delta: 'hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'completed' },
    ]);
  });

  it('rejects duplicate registry IDs and unavailable providers', () => {
    const registry = new ProviderRegistry();
    registry.register('fake', new FakeProviderAdapter());

    expect(() => registry.register('fake', new FakeProviderAdapter())).toThrow('duplicate_provider');
    expect(() => registry.require('missing')).toThrow('provider_unavailable');
  });

  it('reports conservative, unverified capabilities without starting a run', async () => {
    const adapter = new FakeProviderAdapter();

    await expect(adapter.probeCapabilities()).resolves.toEqual({
      available: true,
      verified: false,
      modelSelection: true,
      effortSelection: true,
      modelOptions: [{ id: 'fake', label: 'Fake', effortOptions: ['low', 'medium', 'high'] }],
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      resume: true,
      cancellation: true,
    });
    await expect(adapter.probeCapabilities({ mode: 'static' })).resolves.toEqual(
      await adapter.probeCapabilities(),
    );
  });

  it('emits fragmented structured envelope JSON when an output schema is requested', async () => {
    const adapter = new FakeProviderAdapter({
      chunks: ['{"answer":', '"ok"}'],
      structuredEnvelope: { answer: 'ok' },
    });

    await expect(collect(adapter.start(request({ outputSchema: { type: 'object' } })))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      { type: 'structured_delta', delta: '{"answer":' },
      { type: 'structured_delta', delta: '"ok"}' },
      { type: 'completed' },
    ]);
  });

  it('falls back to at least two exact structured fragments when configured chunks do not match', async () => {
    const adapter = new FakeProviderAdapter({
      chunks: ['not the envelope'],
      structuredEnvelope: { answer: 'ok' },
    });

    const events = await collect(adapter.start(request({ outputSchema: { type: 'object' } })));
    const deltas = events.filter((event) => event.type === 'structured_delta').map((event) => event.delta);

    expect(deltas).toHaveLength(2);
    expect(deltas.join('')).toBe(JSON.stringify({ answer: 'ok' }));
    expect(events.at(-1)).toEqual({ type: 'completed' });
  });

  it('applies a deterministic delay to each emitted chunk', async () => {
    const adapter = new FakeProviderAdapter({ chunks: ['a', 'b'], delayMs: 20 });
    const startedAt = Date.now();

    await expect(collect(adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
      { type: 'completed' },
    ]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
  });

  it('fails before session creation without advancing native state', async () => {
    const adapter = new FakeProviderAdapter({ failBeforeSession: true });

    await expect(collect(adapter.start(request()))).resolves.toEqual([
      {
        type: 'failed',
        code: 'fake_failed_before_session',
        message: 'Fake provider failed before starting a session',
        nativeStateAdvanced: false,
      },
    ]);
  });

  it('fails after session creation before output is streamed', async () => {
    const adapter = new FakeProviderAdapter({ failAfterSession: true });

    await expect(collect(adapter.start(request()))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      {
        type: 'failed',
        code: 'fake_failed_after_session',
        message: 'Fake provider failed after starting a session',
        nativeStateAdvanced: true,
      },
    ]);
  });

  it('cleans terminal failure state before yielding the event', async () => {
    const { controller, removeEventListener } = watchAbortCleanup();
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    const adapter = new FakeProviderAdapter({ failBeforeSession: true });

    try {
      const iterator = adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'failed', code: 'fake_failed_before_session' },
      });
      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  it('resumes the supplied native session', async () => {
    const adapter = new FakeProviderAdapter({ chunks: ['continued'] });

    await expect(collect(adapter.resume({ ...request(), nativeSessionId: 'native_session_1' }))).resolves.toEqual([
      { type: 'session_started', nativeSessionId: 'native_session_1' },
      { type: 'text_delta', delta: 'continued' },
      { type: 'completed' },
    ]);
  });

  it('cancels an active stream from its AbortSignal without leaking delayed output', async () => {
    const { controller, removeEventListener } = watchAbortCleanup();
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    const adapter = new FakeProviderAdapter({ chunks: ['late'], delayMs: 100 });
    const events = adapter.start(request({ signal: controller.signal }));
    const iterator = events[Symbol.asyncIterator]();

    try {
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      });
      const nextEvent = iterator.next();
      controller.abort();

      await expect(nextEvent).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  it('cancels before session creation when its AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const adapter = new FakeProviderAdapter();

    await expect(collect(adapter.start(request({ signal: controller.signal })))).resolves.toEqual([
      { type: 'cancelled' },
    ]);
  });

  it('cancels an active stream by run ID', async () => {
    const adapter = new FakeProviderAdapter({ chunks: ['late'], delayMs: 100 });
    const iterator = adapter.start(request())[Symbol.asyncIterator]();

    await iterator.next();
    const nextEvent = iterator.next();
    await adapter.cancel('run_1');

    await expect(nextEvent).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('cleans completed state before yielding the terminal event', async () => {
    const { controller, removeEventListener } = watchAbortCleanup();
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    const adapter = new FakeProviderAdapter({ chunks: ['done'] });

    try {
      const iterator = adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();
      await iterator.next();

      await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'text_delta', delta: 'done' } });
      await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'completed' } });
      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  it('cleans state when a consumer returns before a terminal event', async () => {
    const { controller, removeEventListener } = watchAbortCleanup();
    const abort = vi.spyOn(AbortController.prototype, 'abort');
    const adapter = new FakeProviderAdapter({ chunks: ['late'], delayMs: 100 });

    try {
      const iterator = adapter.start(request({ signal: controller.signal }))[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
      expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  it('cancels every concurrent stream with the same run ID and leaves no stale state', async () => {
    const adapter = new FakeProviderAdapter({ chunks: ['late'], delayMs: 100 });
    const first = adapter.start(request())[Symbol.asyncIterator]();
    const second = adapter.start(request())[Symbol.asyncIterator]();
    const abort = vi.spyOn(AbortController.prototype, 'abort');

    try {
      await Promise.all([first.next(), second.next()]);
      const firstCancelled = first.next();
      const secondCancelled = second.next();

      await adapter.cancel('run_1');
      await expect(Promise.all([firstCancelled, secondCancelled])).resolves.toEqual([
        { done: false, value: { type: 'cancelled' } },
        { done: false, value: { type: 'cancelled' } },
      ]);

      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  it('keeps a same-run stream cancellable after its sibling returns early', async () => {
    const firstRequest = watchAbortCleanup();
    const secondRequest = watchAbortCleanup();
    const adapter = new FakeProviderAdapter({ chunks: ['late'], delayMs: 100 });
    const first = adapter.start(request({ signal: firstRequest.controller.signal }))[Symbol.asyncIterator]();
    const second = adapter.start(request({ signal: secondRequest.controller.signal }))[Symbol.asyncIterator]();
    const abort = vi.spyOn(AbortController.prototype, 'abort');

    try {
      await expect(first.next()).resolves.toEqual({
        done: false,
        value: { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      });
      await expect(second.next()).resolves.toEqual({
        done: false,
        value: { type: 'session_started', nativeSessionId: 'fake_session_run_1' },
      });

      await expect(first.return?.()).resolves.toEqual({ done: true, value: undefined });
      expect(firstRequest.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

      const secondCancelled = second.next();
      await adapter.cancel('run_1');

      await expect(secondCancelled).resolves.toEqual({ done: false, value: { type: 'cancelled' } });
      expect(secondRequest.removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(abort).toHaveBeenCalledTimes(1);

      await expect(second.next()).resolves.toEqual({ done: true, value: undefined });
      abort.mockClear();
      await adapter.cancel('run_1');
      expect(abort).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });
});
