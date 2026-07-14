import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../types.js';

export interface FakeProviderAdapterOptions {
  chunks?: string[];
  delayMs?: number;
  failBeforeSession?: boolean;
  failAfterSession?: boolean;
  structuredEnvelope?: Record<string, unknown>;
}

export class FakeProviderAdapter implements ProviderAdapter {
  private readonly activeRuns = new Map<string, Set<AbortController>>();

  constructor(private readonly options: FakeProviderAdapterOptions = {}) {}

  async probeCapabilities(_request?: ProviderProbeRequest): Promise<ProviderCapabilities> {
    return {
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
    };
  }

  start(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    return this.stream(request, `fake_session_${request.runId}`);
  }

  resume(request: ProviderResumeRequest): AsyncIterable<ProviderEvent> {
    return this.stream(request, request.nativeSessionId);
  }

  async cancel(runId: string): Promise<void> {
    this.activeRuns.get(runId)?.forEach((controller) => controller.abort());
  }

  private async *stream(request: ProviderRequest, nativeSessionId: string): AsyncGenerator<ProviderEvent> {
    const cancellation = new AbortController();
    const abortRequest = () => cancellation.abort();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      request.signal.removeEventListener('abort', abortRequest);
      const controllers = this.activeRuns.get(request.runId);
      if (!controllers) return;
      controllers.delete(cancellation);
      if (controllers.size === 0) this.activeRuns.delete(request.runId);
    };

    request.signal.addEventListener('abort', abortRequest, { once: true });
    if (request.signal.aborted) cancellation.abort();
    const controllers = this.activeRuns.get(request.runId) ?? new Set<AbortController>();
    controllers.add(cancellation);
    this.activeRuns.set(request.runId, controllers);

    try {
      if (cancellation.signal.aborted) {
        cleanup();
        yield { type: 'cancelled' };
        return;
      }

      if (this.options.failBeforeSession) {
        cleanup();
        yield {
          type: 'failed',
          code: 'fake_failed_before_session',
          message: 'Fake provider failed before starting a session',
          nativeStateAdvanced: false,
        };
        return;
      }

      yield { type: 'session_started', nativeSessionId };

      if (this.options.failAfterSession) {
        cleanup();
        yield {
          type: 'failed',
          code: 'fake_failed_after_session',
          message: 'Fake provider failed after starting a session',
          nativeStateAdvanced: true,
        };
        return;
      }

      const structured = request.outputSchema !== null;
      for (const chunk of this.chunks(structured)) {
        if (await waitForDelay(this.options.delayMs ?? 0, cancellation.signal)) {
          cleanup();
          yield { type: 'cancelled' };
          return;
        }
        if (cancellation.signal.aborted) {
          cleanup();
          yield { type: 'cancelled' };
          return;
        }
        yield structured ? { type: 'structured_delta', delta: chunk } : { type: 'text_delta', delta: chunk };
      }

      if (cancellation.signal.aborted) {
        cleanup();
        yield { type: 'cancelled' };
        return;
      }
      cleanup();
      yield { type: 'completed' };
    } finally {
      cleanup();
    }
  }

  private chunks(structured: boolean): string[] {
    if (!structured) return this.options.chunks ?? ['fake response'];

    const envelope = JSON.stringify(this.options.structuredEnvelope ?? {});
    const chunks = this.options.chunks;
    if (chunks && chunks.length >= 2 && chunks.join('') === envelope) return chunks;

    const splitAt = Math.ceil(envelope.length / 2);
    return [envelope.slice(0, splitAt), envelope.slice(splitAt)];
  }
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  if (delayMs <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const complete = (cancelled: boolean) => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(cancelled);
    };
    const onAbort = () => complete(true);

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      complete(true);
      return;
    }
    timer = setTimeout(() => complete(false), delayMs);
  });
}
