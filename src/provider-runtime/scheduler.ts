import type { InvocationTarget } from '../control-plane/types.js';
import { GatewayError } from '../server/errors.js';

type Operation<T> = (signal: AbortSignal) => Promise<T>;

interface QueueEntry<T> {
  runId: string;
  enqueuedAt: number;
  expiresAt: number;
  signal: AbortSignal;
  runTimeoutMs: number | null;
  operation: Operation<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  onAbort: () => void;
}

interface TargetState {
  active: number;
  maxConcurrency: number;
  queue: QueueEntry<unknown>[];
}

function targetBusy(message: string): GatewayError {
  return new GatewayError(429, 'target_busy', message);
}

function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

function timeoutError(): DOMException {
  return new DOMException('Target run timed out', 'TimeoutError');
}

export class TargetScheduler {
  private readonly states = new Map<string, TargetState>();

  run<T>(
    runId: string,
    target: InvocationTarget,
    signal: AbortSignal,
    operation: Operation<T>,
  ): Promise<T> {
    let state = this.states.get(target.id);
    if (!state) {
      state = { active: 0, maxConcurrency: target.maxConcurrency, queue: [] };
      this.states.set(target.id, state);
    } else {
      state.maxConcurrency = target.maxConcurrency;
    }

    // Apply the latest limit to queued work before this invocation can use capacity.
    this.drain(target.id, state);

    if (signal.aborted) {
      this.deleteIfIdle(target.id, state);
      return Promise.reject(signal.reason);
    }

    if (state.active < state.maxConcurrency) {
      return this.start(target.id, state, signal, target.runTimeoutMs, operation);
    }

    if (state.queue.length >= target.maxQueue) {
      return Promise.reject(targetBusy(`Target ${target.id} queue is full`));
    }

    return new Promise<T>((resolve, reject) => {
      const enqueuedAt = Date.now();
      const entry: QueueEntry<unknown> = {
        runId,
        enqueuedAt,
        expiresAt: enqueuedAt + target.queueTimeoutMs,
        signal,
        runTimeoutMs: target.runTimeoutMs,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        timeout: null,
        onAbort: () => {
          if (this.removeQueued(state, entry)) {
            this.disposeQueued(entry);
            reject(signal.reason);
            this.deleteIfIdle(target.id, state);
          }
        },
      };

      entry.timeout = setTimeout(() => {
        if (this.removeQueued(state, entry)) {
          this.disposeQueued(entry);
          reject(targetBusy(`Target ${target.id} queue wait timed out`));
          this.deleteIfIdle(target.id, state);
        }
      }, target.queueTimeoutMs);
      signal.addEventListener('abort', entry.onAbort, { once: true });
      state.queue.push(entry);
    });
  }

  cancelQueued(runId: string): boolean {
    let cancelled = false;

    for (const [targetId, state] of this.states) {
      for (let index = state.queue.length - 1; index >= 0; index -= 1) {
        const entry = state.queue[index]!;
        if (entry.runId !== runId) continue;

        state.queue.splice(index, 1);
        this.disposeQueued(entry);
        entry.reject(abortError(`Queued run ${runId} was cancelled`));
        cancelled = true;
      }
      this.deleteIfIdle(targetId, state);
    }

    return cancelled;
  }

  private start<T>(
    targetId: string,
    state: TargetState,
    callerSignal: AbortSignal,
    runTimeoutMs: number | null,
    operation: Operation<T>,
  ): Promise<T> {
    if (callerSignal.aborted) return Promise.reject(callerSignal.reason);

    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    if (callerSignal.aborted) {
      callerSignal.removeEventListener('abort', onCallerAbort);
      return Promise.reject(callerSignal.reason);
    }

    state.active += 1;
    const timeout =
      runTimeoutMs === null
        ? null
        : setTimeout(() => controller.abort(timeoutError()), runTimeoutMs);

    let result: Promise<T>;
    try {
      result = Promise.resolve(operation(controller.signal));
    } catch (error) {
      result = Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        callerSignal.removeEventListener('abort', onCallerAbort);
        if (timeout !== null) clearTimeout(timeout);
        state.active -= 1;
        this.drain(targetId, state);
        this.deleteIfIdle(targetId, state);
      };

      void result.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  }

  private drain(targetId: string, state: TargetState): void {
    while (state.active < state.maxConcurrency && state.queue.length > 0) {
      const entry = state.queue.shift()!;
      this.disposeQueued(entry);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      void this.start(targetId, state, entry.signal, entry.runTimeoutMs, entry.operation).then(
        entry.resolve,
        entry.reject,
      );
    }
  }

  private removeQueued(state: TargetState, entry: QueueEntry<unknown>): boolean {
    const index = state.queue.indexOf(entry);
    if (index < 0) return false;
    state.queue.splice(index, 1);
    return true;
  }

  private disposeQueued(entry: QueueEntry<unknown>): void {
    if (entry.timeout !== null) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
    }
    entry.signal.removeEventListener('abort', entry.onAbort);
  }

  private deleteIfIdle(targetId: string, state: TargetState): void {
    if (state.active === 0 && state.queue.length === 0 && this.states.get(targetId) === state) {
      this.states.delete(targetId);
    }
  }
}
