import { z } from 'zod';
import type { RunRepository } from '../control-plane/runs.js';
import { hasCurrentCompatibleCapability, type TargetRepository } from '../control-plane/targets.js';
import type { InvocationTarget, RunRecord } from '../control-plane/types.js';
import type { ProviderRegistry } from './registry.js';
import type { TargetScheduler } from './scheduler.js';
import {
  ImageAssetError,
  ImageAssetMaterializer,
  type ImageAssetLease,
  type ImageAssetMaterializerLike,
} from './image-assets.js';
import { providerSupportsImageInput } from './image-support.js';
import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderImageSource,
  ProviderInputItem,
  ProviderRequest,
  ProviderResumeRequest,
} from './types.js';
import type { WorkspaceLease, WorkspaceManager } from './workspaces.js';

const providerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_started'), nativeSessionId: z.string().min(1) }).strict(),
  z.object({ type: z.literal('text_delta'), delta: z.string() }).strict(),
  z.object({ type: z.literal('structured_delta'), delta: z.string() }).strict(),
  z.object({ type: z.literal('completed') }).strict(),
  z.object({ type: z.literal('cancelled') }).strict(),
  z.object({
    type: z.literal('failed'),
    code: z.string().min(1),
    message: z.string(),
    nativeStateAdvanced: z.boolean(),
  }).strict(),
]);

const TRANSIENT_SPAWN_FAILURES = new Set(['provider_spawn_failed', 'spawn_failed']);

type Registry = Pick<ProviderRegistry, 'require'>;
type Scheduler = Pick<TargetScheduler, 'run' | 'cancelQueued'>;
type Workspaces = Pick<WorkspaceManager, 'acquireChat' | 'createResponse' | 'openResponse'>;
type Targets = Pick<TargetRepository, 'get'>;
type Runs = Pick<
  RunRepository,
  'create' | 'get' | 'markStarted' | 'setNativeSessionId' | 'markFinished' | 'markQueuedFinished'
>;

export interface InvocationRequest {
  runId?: string;
  clientId?: string | null;
  extensionId: string;
  targetId: string;
  endpoint: string;
  responseId?: string | null;
  input: ProviderInputItem[];
  images?: ProviderImageSource[];
  sessionMode: 'ephemeral' | 'persistent';
  outputSchema?: Record<string, unknown> | null;
  nativeSessionId?: string;
  workspacePath?: string;
}

class ConsumerClosedError extends Error {}
class AdapterProtocolError extends Error {}

interface PendingValue<T> {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface InvocationStream {
  next(): Promise<IteratorResult<ProviderEvent>>;
  abort(): Promise<void>;
}

class BoundedChannel<T> {
  private pending: PendingValue<T> | undefined;
  private receiver: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  } | undefined;
  private closed = false;
  private error: unknown;

  send(value: T, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new ConsumerClosedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.receiver) {
      const receiver = this.receiver;
      this.receiver = undefined;
      receiver.resolve({ done: false, value });
      return Promise.resolve();
    }
    if (this.pending) return Promise.reject(new Error('channel_send_overlap'));

    return new Promise<void>((resolve, reject) => {
      const pending: PendingValue<T> = { value, resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => {
          if (this.pending !== pending) return;
          this.pending = undefined;
          reject(signal.reason);
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending = pending;
    });
  }

  next(): Promise<IteratorResult<T>> {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.resolve();
      return Promise.resolve({ done: false, value: pending.value });
    }
    if (this.closed) {
      return this.error === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.error);
    }
    if (this.receiver) return Promise.reject(new Error('channel_receive_overlap'));
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.receiver = { resolve, reject };
    });
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(new ConsumerClosedError());
    }
    if (this.receiver) {
      const receiver = this.receiver;
      this.receiver = undefined;
      if (error === undefined) receiver.resolve({ done: true, value: undefined });
      else receiver.reject(error);
    }
  }
}

function isTerminal(event: ProviderEvent): boolean {
  return event.type === 'completed' || event.type === 'cancelled' || event.type === 'failed';
}

function protocolFailure(nativeStateAdvanced: boolean): ProviderEvent {
  return {
    type: 'failed',
    code: 'adapter_protocol_error',
    message: 'Provider adapter emitted an invalid event sequence',
    nativeStateAdvanced,
  };
}

function thrownFailure(error: unknown, signal: AbortSignal, nativeStateAdvanced: boolean): ProviderEvent {
  const reason = signal.aborted ? signal.reason : error;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return {
      type: 'failed',
      code: 'provider_timeout',
      message: 'Provider invocation timed out',
      nativeStateAdvanced,
    };
  }
  if (signal.aborted || error instanceof ConsumerClosedError
    || (reason instanceof DOMException && reason.name === 'AbortError')) {
    return { type: 'cancelled' };
  }
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[a-z][a-z0-9_]*$/.test(error.code)
    ? error.code
    : 'provider_unavailable';
  return {
    type: 'failed',
    code,
    message: 'Provider invocation failed',
    nativeStateAdvanced,
  };
}

function runOutcome(event: ProviderEvent): {
  status: 'completed' | 'failed' | 'cancelled';
  errorCode?: string;
} {
  if (event.type === 'completed') return { status: 'completed' };
  if (event.type === 'cancelled') return { status: 'cancelled' };
  if (event.type === 'failed') return { status: 'failed', errorCode: event.code };
  throw new Error('terminal_event_required');
}

function nextWithSignal<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });

    let next: Promise<IteratorResult<T>>;
    try {
      next = Promise.resolve(iterator.next());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void next.then(
      (result) => finish(() => {
        if (signal.aborted) reject(signal.reason);
        else resolve(result);
      }),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export class InvocationService {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeAdapters = new Map<string, ProviderAdapter>();
  private readonly activeCompletions = new Map<string, Promise<ProviderEvent>>();

  constructor(
    private readonly registry: Registry,
    private readonly scheduler: Scheduler,
    private readonly workspaces: Workspaces,
    private readonly targets: Targets,
    private readonly runs: Runs,
    private readonly imageAssets: ImageAssetMaterializerLike = new ImageAssetMaterializer(),
  ) {}

  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent> {
    let stream: InvocationStream | undefined;
    let returned = false;
    const open = () => {
      stream ??= this.startInvocation(request);
      return stream;
    };

    const iterator: AsyncIterableIterator<ProviderEvent> = {
      next: async () => {
        if (returned) return { done: true, value: undefined };
        const result = await open().next();
        return returned ? { done: true, value: undefined } : result;
      },
      return: async () => {
        if (!returned) {
          returned = true;
          await stream?.abort();
        }
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  private startInvocation(request: InvocationRequest): InvocationStream {
    const target = this.requireTarget(request.targetId);
    this.validateRequest(request);
    const adapter = this.registry.require(target.cli);
    const run = request.runId === undefined
      ? this.runs.create({
          clientId: request.clientId,
          extensionId: request.extensionId,
          targetId: target.id,
          endpoint: request.endpoint,
          responseId: request.responseId,
        })
      : this.runs.get(request.runId);
    if (!run || run.status !== 'queued') throw new Error('reserved_run_not_found');
    if (request.runId !== undefined && (
      run.clientId !== (request.clientId ?? null)
      || run.extensionId !== request.extensionId
      || run.targetId !== target.id
      || run.endpoint !== request.endpoint
      || run.responseId !== (request.responseId ?? null)
    )) {
      throw new Error('reserved_run_mismatch');
    }
    const controller = new AbortController();
    const channel = new BoundedChannel<ProviderEvent>();
    let started = false;
    let nativeStateAdvanced = false;
    let terminalReceived = false;
    let abortPromise: Promise<void> | undefined;

    this.activeControllers.set(run.id, controller);
    this.activeAdapters.set(run.id, adapter);

    const scheduled = this.scheduler.run(
      run.id,
      target,
      controller.signal,
      async (signal) => {
        this.runs.markStarted(run.id);
        started = true;
        let lease: WorkspaceLease | undefined;
        let imageLease: ImageAssetLease | undefined;
        let terminal: ProviderEvent;
        try {
          lease = await this.acquireWorkspace(request, target, run.id);
          if ((request.images?.length ?? 0) > 0) {
            if (!providerSupportsImageInput(target.cli)) {
              throw new ImageAssetError('image_input_not_supported');
            }
            imageLease = await this.imageAssets.materialize(request.images!, signal);
          }
          terminal = await this.iterateProvider(
            adapter,
            this.providerRequest(request, target, run.id, lease.path, signal, imageLease?.images),
            channel,
            signal,
            (advanced) => { nativeStateAdvanced = advanced; },
          );
        } catch (error) {
          terminal = error instanceof AdapterProtocolError
            ? protocolFailure(nativeStateAdvanced)
            : thrownFailure(error, signal, nativeStateAdvanced);
        }

        if (imageLease) {
          try {
            await imageLease.release();
          } catch {
            if (terminal.type !== 'cancelled') {
              terminal = {
                type: 'failed',
                code: 'image_cleanup_failed',
                message: 'Image input cleanup failed',
                nativeStateAdvanced,
              };
            }
          }
        }

        if (lease) {
          try {
            await lease.release();
          } catch {
            if (terminal.type !== 'cancelled') {
              terminal = {
                type: 'failed',
                code: 'workspace_cleanup_error',
                message: 'Workspace cleanup failed',
                nativeStateAdvanced,
              };
            }
          }
        }

        if (signal.aborted) {
          terminal = thrownFailure(signal.reason, signal, nativeStateAdvanced);
        }

        const outcome = runOutcome(terminal);
        this.runs.markFinished(run.id, outcome.status, outcome.errorCode);
        return terminal;
      },
    ).catch((error: unknown) => {
      const terminal = thrownFailure(error, controller.signal, nativeStateAdvanced);
      const outcome = runOutcome(terminal);
      if (started) this.runs.markFinished(run.id, outcome.status, outcome.errorCode);
      else this.runs.markQueuedFinished(run.id, outcome.status === 'completed' ? 'failed' : outcome.status, outcome.errorCode);
      return terminal;
    }).finally(() => {
      this.activeControllers.delete(run.id);
      this.activeAdapters.delete(run.id);
      this.activeCompletions.delete(run.id);
    });

    const forwarding = scheduled.then(async (terminal) => {
      await channel.send(terminal);
      channel.close();
    }).catch((error: unknown) => channel.close(error));
    this.activeCompletions.set(run.id, scheduled);

    return {
      next: async () => {
        const next = await channel.next();
        if (next.done) return next;
        if (isTerminal(next.value)) terminalReceived = true;
        return next;
      },
      abort: () => {
        abortPromise ??= (async () => {
          if (!terminalReceived) {
            channel.close();
            controller.abort(new DOMException(`Run ${run.id} consumer disconnected`, 'AbortError'));
            if (started) {
              try {
                await adapter.cancel(run.id);
              } catch {
                // The AbortSignal remains authoritative when native cancellation fails.
              }
            }
          }
          await scheduled.catch(() => undefined);
          await forwarding.catch(() => undefined);
        })();
        return abortPromise;
      },
    };
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.activeControllers.get(runId);
    if (!controller) return false;
    const queued = this.scheduler.cancelQueued(runId);
    controller.abort(new DOMException(`Run ${runId} was cancelled`, 'AbortError'));
    const adapter = this.activeAdapters.get(runId);
    let cancellationError: unknown;
    try {
    if (!queued && adapter) {
      try {
        await adapter.cancel(runId);
      } catch {
        // The AbortSignal remains authoritative when native cancellation fails.
      }
      }
    } catch (error) {
      cancellationError = error;
    }
    await this.activeCompletions.get(runId)?.catch(() => undefined);
    if (cancellationError !== undefined) throw cancellationError;
    return true;
  }

  async abortActive(): Promise<void> {
    const runIds = [...this.activeControllers.keys()];
    await Promise.all(runIds.map(async (runId) => {
      await this.cancel(runId);
    }));
  }

  private requireTarget(id: string): InvocationTarget {
    const target = this.targets.get(id);
    if (!target) throw new Error('target_not_found');
    if (!target.enabled) throw new Error('target_disabled');
    if (!hasCurrentCompatibleCapability(target)) throw new Error('capability_mismatch');
    return target;
  }

  private validateRequest(request: InvocationRequest): void {
    if (request.sessionMode === 'persistent' && !request.responseId) {
      throw new Error('response_id_required');
    }
    if (request.nativeSessionId !== undefined && request.workspacePath === undefined) {
      throw new Error('response_workspace_required');
    }
  }

  private acquireWorkspace(
    request: InvocationRequest,
    target: InvocationTarget,
    runId: string,
  ): Promise<WorkspaceLease> {
    if (request.sessionMode === 'ephemeral') return this.workspaces.acquireChat(target, runId);
    if (request.workspacePath !== undefined) return this.workspaces.openResponse(request.workspacePath);
    return this.workspaces.createResponse(target, request.responseId!);
  }

  private providerRequest(
    request: InvocationRequest,
    target: InvocationTarget,
    runId: string,
    workspace: string,
    signal: AbortSignal,
    images?: ProviderRequest['images'],
  ): ProviderRequest | ProviderResumeRequest {
    const providerRequest: ProviderRequest = {
      runId,
      targetId: target.id,
      model: target.nativeModel,
      effort: target.reasoningEffort,
      workspace,
      input: request.input,
      ...(images === undefined ? {} : { images }),
      sessionMode: request.sessionMode,
      runTimeoutMs: target.runTimeoutMs,
      outputSchema: request.outputSchema ?? null,
      signal,
    };
    return request.nativeSessionId === undefined
      ? providerRequest
      : { ...providerRequest, nativeSessionId: request.nativeSessionId };
  }

  private async iterateProvider(
    adapter: ProviderAdapter,
    providerRequest: ProviderRequest | ProviderResumeRequest,
    channel: BoundedChannel<ProviderEvent>,
    signal: AbortSignal,
    setNativeStateAdvanced: (advanced: boolean) => void,
  ): Promise<ProviderEvent> {
    let sessionStarted = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let terminal: ProviderEvent | undefined;
      const events = 'nativeSessionId' in providerRequest
        ? adapter.resume(providerRequest)
        : adapter.start(providerRequest);
      const iterator = (events as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      let exhausted = false;

      try {
        while (true) {
          const next = await nextWithSignal(iterator, signal);
          if (next.done) {
            exhausted = true;
            break;
          }
          if (signal.aborted) throw signal.reason;
          const parsed = providerEventSchema.safeParse(next.value);
          if (!parsed.success || terminal) throw new AdapterProtocolError();
          const event = parsed.data;
          if (isTerminal(event)) {
            terminal = event;
            continue;
          }
          if (event.type === 'session_started') {
            if (sessionStarted) throw new AdapterProtocolError();
            sessionStarted = true;
            setNativeStateAdvanced(true);
            this.runs.setNativeSessionId(providerRequest.runId, event.nativeSessionId);
          } else if (!sessionStarted) {
            throw new AdapterProtocolError();
          }
          await channel.send(event, signal);
        }
      } finally {
        if (!exhausted && iterator.return) {
          try {
            const closing = Promise.resolve(iterator.return());
            if (signal.aborted) void closing.catch(() => undefined);
            else await closing;
          } catch (error) {
            if (!signal.aborted) throw error;
          }
        }
      }

      if (signal.aborted) throw signal.reason;
      if (!terminal) throw new AdapterProtocolError();
      const retry = attempt === 0
        && !sessionStarted
        && terminal.type === 'failed'
        && terminal.nativeStateAdvanced === false
        && TRANSIENT_SPAWN_FAILURES.has(terminal.code);
      if (retry) continue;
      if (terminal.type === 'failed' && terminal.nativeStateAdvanced) setNativeStateAdvanced(true);
      if (signal.aborted) throw signal.reason;
      return terminal;
    }

    throw new AdapterProtocolError();
  }
}
