import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import { GatewayError } from '../../src/server/errors.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';

function target(overrides: Partial<InvocationTarget> = {}): InvocationTarget {
  return {
    id: 'target-a',
    aliases: [],
    cli: 'fake',
    nativeModel: 'fake',
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
    capabilityVersion: null,
    capabilityVerifiedAt: null,
    capabilities: null,
    capabilityError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectTargetBusy(error: unknown) {
  expect(error).toBeInstanceOf(GatewayError);
  expect(error).toMatchObject({ code: 'target_busy' });
}

describe('TargetScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serializes operations at concurrency one and preserves FIFO order', async () => {
    const scheduler = new TargetScheduler();
    const first = deferred<string>();
    const second = deferred<string>();
    const order: string[] = [];

    const firstRun = scheduler.run('run-1', target(), new AbortController().signal, async () => {
      order.push('first');
      return first.promise;
    });
    const secondRun = scheduler.run('run-2', target(), new AbortController().signal, async () => {
      order.push('second');
      return second.promise;
    });
    const thirdRun = scheduler.run('run-3', target(), new AbortController().signal, async () => {
      order.push('third');
      return 'third';
    });

    expect(order).toEqual(['first']);
    first.resolve('first');
    await expect(firstRun).resolves.toBe('first');
    expect(order).toEqual(['first', 'second']);
    second.resolve('second');
    await expect(secondRun).resolves.toBe('second');
    await expect(thirdRun).resolves.toBe('third');
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('overlaps operations up to maxConcurrency', async () => {
    const scheduler = new TargetScheduler();
    const blockers = [deferred<void>(), deferred<void>()];
    let active = 0;
    let peak = 0;
    const run = (runId: string, blocker: ReturnType<typeof deferred<void>>) =>
      scheduler.run(runId, target({ maxConcurrency: 2 }), new AbortController().signal, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blocker.promise;
        active -= 1;
      });

    const runs = [run('run-1', blockers[0]), run('run-2', blockers[1])];
    expect(peak).toBe(2);
    blockers.forEach((blocker) => blocker.resolve());
    await Promise.all(runs);
  });

  it('uses a lower live concurrency limit to queue later work without cancelling active work', async () => {
    const scheduler = new TargetScheduler();
    const first = deferred<void>();
    const order: string[] = [];
    const firstRun = scheduler.run(
      'run-1',
      target({ maxConcurrency: 2 }),
      new AbortController().signal,
      async () => {
        order.push('first');
        await first.promise;
      },
    );
    const secondRun = scheduler.run(
      'run-2',
      target({ maxConcurrency: 1 }),
      new AbortController().signal,
      async () => {
        order.push('second');
      },
    );

    expect(order).toEqual(['first']);
    first.resolve();
    await firstRun;
    await secondRun;
    expect(order).toEqual(['first', 'second']);
  });

  it('uses increased live capacity for queued work before admitting the new request', async () => {
    const scheduler = new TargetScheduler();
    const first = deferred<void>();
    const second = deferred<void>();
    const order: string[] = [];
    const firstRun = scheduler.run('run-1', target(), new AbortController().signal, async () => {
      order.push('first');
      await first.promise;
    });
    const secondRun = scheduler.run('run-2', target(), new AbortController().signal, async () => {
      order.push('second');
      await second.promise;
    });
    const thirdRun = scheduler.run(
      'run-3',
      target({ maxConcurrency: 2 }),
      new AbortController().signal,
      async () => {
        order.push('third');
      },
    );

    expect(order).toEqual(['first', 'second']);
    first.resolve();
    await firstRun;
    expect(order).toEqual(['first', 'second', 'third']);
    second.resolve();
    await Promise.all([secondRun, thirdRun]);
  });

  it('schedules different targets independently', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const first = scheduler.run('run-1', target(), new AbortController().signal, () => blocker.promise);

    await expect(
      scheduler.run('run-2', target({ id: 'target-b' }), new AbortController().signal, async () => 'b'),
    ).resolves.toBe('b');
    blocker.resolve();
    await first;
  });

  it('rejects overflow without starting the operation', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const active = scheduler.run('active', target(), new AbortController().signal, () => blocker.promise);
    const queued = Array.from({ length: 8 }, (_, index) =>
      scheduler.run(`queued-${index}`, target(), new AbortController().signal, async () => index),
    );
    const overflowOperation = vi.fn(async () => undefined);

    await scheduler
      .run('overflow', target(), new AbortController().signal, overflowOperation)
      .then(() => expect.unreachable(), expectTargetBusy);
    expect(overflowOperation).not.toHaveBeenCalled();
    blocker.resolve();
    await active;
    await Promise.all(queued);
  });

  it('times out the exact queued entry with target_busy', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const active = scheduler.run('active', target(), new AbortController().signal, () => blocker.promise);
    const timedOut = scheduler.run('queued', target(), new AbortController().signal, async () => 'late');

    const rejection = timedOut.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expectTargetBusy(await rejection);
    blocker.resolve();
    await active;
  });

  it('rejects a pre-aborted request without starting it', async () => {
    const scheduler = new TargetScheduler();
    const controller = new AbortController();
    const operation = vi.fn(async () => undefined);
    controller.abort('cancelled');

    await expect(scheduler.run('run-1', target(), controller.signal, operation)).rejects.toBe('cancelled');
    expect(operation).not.toHaveBeenCalled();
  });

  it('aborting a queued request removes only that entry', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const controller = new AbortController();
    const order: string[] = [];
    const active = scheduler.run('active', target(), new AbortController().signal, () => blocker.promise);
    const aborted = scheduler.run('aborted', target(), controller.signal, async () => {
      order.push('aborted');
    });
    const survivor = scheduler.run('survivor', target(), new AbortController().signal, async () => {
      order.push('survivor');
    });

    controller.abort('stop');
    await expect(aborted).rejects.toBe('stop');
    blocker.resolve();
    await active;
    await survivor;
    expect(order).toEqual(['survivor']);
  });

  it('does not start queued work aborted during a reentrant live-limit drain', async () => {
    const scheduler = new TargetScheduler();
    const activeBlocker = deferred<void>();
    const reentrantBlocker = deferred<void>();
    const queuedCaller = new AbortController();
    const removeEventListener = vi.spyOn(queuedCaller.signal, 'removeEventListener');
    const abortReason = new Error('queued caller stopped');
    const order: string[] = [];
    let reentrantRun: Promise<void> | undefined;

    const activeRun = scheduler.run('active', target(), new AbortController().signal, async () => {
      order.push('active');
      await activeBlocker.promise;
    });

    queuedCaller.signal.addEventListener(
      'abort',
      () => {
        reentrantRun = scheduler.run(
          'reentrant',
          target({ maxConcurrency: 2 }),
          new AbortController().signal,
          async () => {
            order.push('reentrant');
            await reentrantBlocker.promise;
          },
        );
      },
      { once: true },
    );

    const queuedOperation = vi.fn(async (_signal: AbortSignal) => {
      order.push('aborted');
    });
    const queuedRun = scheduler.run('queued', target(), queuedCaller.signal, queuedOperation);
    const queuedRejection = queuedRun.catch((error: unknown) => error);

    queuedCaller.abort(abortReason);

    expect(await queuedRejection).toBe(abortReason);
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(order).toEqual(['active', 'reentrant']);
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const survivorRun = scheduler.run(
      'survivor',
      target({ maxConcurrency: 2 }),
      new AbortController().signal,
      async () => {
        order.push('survivor');
      },
    );
    expect(order).toEqual(['active', 'reentrant']);

    reentrantBlocker.resolve();
    await reentrantRun;
    await survivorRun;
    activeBlocker.resolve();
    await activeRun;

    await scheduler.run('after', target(), new AbortController().signal, async () => {
      order.push('after');
    });
    expect(order).toEqual(['active', 'reentrant', 'survivor', 'after']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelQueued removes the matching run without touching active work', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const activeOperation = vi.fn(() => blocker.promise);
    const queuedOperation = vi.fn(async () => undefined);
    const active = scheduler.run('same-id', target(), new AbortController().signal, activeOperation);
    const queued = scheduler.run('queued-id', target(), new AbortController().signal, queuedOperation);

    expect(scheduler.cancelQueued('same-id')).toBe(false);
    expect(scheduler.cancelQueued('queued-id')).toBe(true);
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(activeOperation).toHaveBeenCalledOnce();
    expect(queuedOperation).not.toHaveBeenCalled();
    blocker.resolve();
    await active;
  });

  it('cancelQueued cancels every queued match when run IDs are reused across targets', async () => {
    const scheduler = new TargetScheduler();
    const blockers = [deferred<void>(), deferred<void>()];
    const active = blockers.map((blocker, index) =>
      scheduler.run(`active-${index}`, target({ id: `target-${index}` }), new AbortController().signal, () => blocker.promise),
    );
    const queued = [0, 1].map((index) =>
      scheduler.run('duplicate', target({ id: `target-${index}` }), new AbortController().signal, async () => index),
    );

    expect(scheduler.cancelQueued('duplicate')).toBe(true);
    await Promise.all(queued.map((run) => expect(run).rejects.toMatchObject({ name: 'AbortError' })));
    blockers.forEach((blocker) => blocker.resolve());
    await Promise.all(active);
  });

  it('passes one composed signal to active work and forwards caller abort', async () => {
    const scheduler = new TargetScheduler();
    const caller = new AbortController();
    let received: AbortSignal | undefined;
    const run = scheduler.run('run-1', target(), caller.signal, async (signal) => {
      received = signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });

    expect(received).toBeDefined();
    expect(received).not.toBe(caller.signal);
    caller.abort('caller-stop');
    await run;
    expect(received?.aborted).toBe(true);
    expect(received?.reason).toBe('caller-stop');
  });

  it('starts run timeout only when active and aborts with TimeoutError', async () => {
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const active = scheduler.run('active', target(), new AbortController().signal, () => blocker.promise);
    let queuedSignal: AbortSignal | undefined;
    const queued = scheduler.run(
      'queued',
      target({ queueTimeoutMs: 10_000, runTimeoutMs: 500 }),
      new AbortController().signal,
      async (signal) => {
        queuedSignal = signal;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    );

    await vi.advanceTimersByTimeAsync(600);
    expect(queuedSignal).toBeUndefined();
    blocker.resolve();
    await active;
    expect(queuedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await queued;
    expect(queuedSignal?.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('does not create a run timer when runTimeoutMs is null', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = new TargetScheduler();

    await expect(
      scheduler.run('run-1', target({ queueTimeoutMs: 47_000, runTimeoutMs: null }), new AbortController().signal, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(timer).not.toHaveBeenCalled();
  });

  it('clears the active run timer and caller listener on completion', async () => {
    const timer = vi.spyOn(globalThis, 'clearTimeout');
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const scheduler = new TargetScheduler();

    await scheduler.run('run-1', target({ runTimeoutMs: 500 }), controller.signal, async () => 'ok');

    expect(timer).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('clears queued timers and listeners on start, timeout, abort, and cancellation', async () => {
    const timer = vi.spyOn(globalThis, 'clearTimeout');
    const scheduler = new TargetScheduler();
    const blocker = deferred<void>();
    const active = scheduler.run('active', target(), new AbortController().signal, () => blocker.promise);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const removals = controllers.map(({ signal }) => vi.spyOn(signal, 'removeEventListener'));
    const started = scheduler.run('started', target(), controllers[0].signal, async () => undefined);
    const timedOut = scheduler.run('timed-out', target({ queueTimeoutMs: 100 }), controllers[1].signal, async () => undefined);
    const aborted = scheduler.run('aborted', target(), controllers[2].signal, async () => undefined);
    const cancelled = scheduler.run('cancelled', target(), controllers[3].signal, async () => undefined);

    controllers[2].abort();
    scheduler.cancelQueued('cancelled');
    const abortedResult = expect(aborted).rejects.toBeInstanceOf(DOMException);
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const timeoutResult = timedOut.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    blocker.resolve();
    await Promise.all([active, started, abortedResult, cancelledResult]);
    expectTargetBusy(await timeoutResult);

    expect(timer).toHaveBeenCalledTimes(4);
    for (const removal of removals) {
      expect(removal).toHaveBeenCalledWith('abort', expect.any(Function));
    }
  });

  it('handles operation rejection and synchronous throws, then drains once', async () => {
    const scheduler = new TargetScheduler();
    const order: string[] = [];
    const rejected = scheduler.run('rejected', target(), new AbortController().signal, async () => {
      order.push('rejected');
      throw new Error('async failure');
    });
    const thrown = scheduler.run('thrown', target(), new AbortController().signal, () => {
      order.push('thrown');
      throw new Error('sync failure');
    });
    const final = scheduler.run('final', target(), new AbortController().signal, async () => {
      order.push('final');
      return 'ok';
    });

    await expect(rejected).rejects.toThrow('async failure');
    await expect(thrown).rejects.toThrow('sync failure');
    await expect(final).resolves.toBe('ok');
    expect(order).toEqual(['rejected', 'thrown', 'final']);
  });

  it('does not retain idle target policy and has no fixed 30-second timer', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = new TargetScheduler();

    await scheduler.run('first', target({ maxConcurrency: 1 }), new AbortController().signal, async () => undefined);
    const operations = [0, 1].map((index) =>
      scheduler.run(`next-${index}`, target({ maxConcurrency: 2 }), new AbortController().signal, async () => index),
    );

    await expect(Promise.all(operations)).resolves.toEqual([0, 1]);
    expect(timer.mock.calls.some(([, delay]) => delay === 30_000)).toBe(false);
  });
});
