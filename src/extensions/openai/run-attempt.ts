import type { RunRepository } from '../../control-plane/runs.js';
import { normalizeOpenAIError } from './errors.js';
import { OPENAI_EXTENSION_ID } from './models.js';

type OpenAIRunRepository = Pick<
  RunRepository,
  'create' | 'get' | 'markStarted' | 'markQueuedFinished' | 'markFinished'
>;

const UNRESOLVED_MODEL = 'unresolved-model';
const MAX_RECORDED_MODEL_LENGTH = 256;

function requestedModel(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('model' in body)) return UNRESOLVED_MODEL;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== 'string' || model.trim().length === 0) return UNRESOLVED_MODEL;
  return model.trim().slice(0, MAX_RECORDED_MODEL_LENGTH);
}

export class OpenAIRunAttempt {
  private targetId: string;
  private responseId: string | null = null;
  private runId: string | undefined;
  private ignored = false;

  constructor(
    private readonly runs: OpenAIRunRepository,
    private readonly clientId: string,
    private readonly endpoint: 'chat.completions' | 'responses',
    body: unknown,
  ) {
    this.targetId = requestedModel(body);
  }

  setTarget(targetId: string): void {
    if (this.runId !== undefined || this.ignored) throw new Error('run_attempt_already_bound');
    this.targetId = targetId;
  }

  setResponseId(responseId: string): void {
    if (this.runId !== undefined || this.ignored) throw new Error('run_attempt_already_bound');
    this.responseId = responseId;
  }

  reserve(): string {
    if (this.ignored) throw new Error('run_attempt_ignored');
    if (this.runId !== undefined) return this.runId;
    const run = this.runs.create({
      clientId: this.clientId,
      extensionId: OPENAI_EXTENSION_ID,
      targetId: this.targetId,
      endpoint: this.endpoint,
      responseId: this.responseId,
    });
    this.runId = run.id;
    return run.id;
  }

  claim(runId: string): void {
    if (this.ignored || (this.runId !== undefined && this.runId !== runId)) {
      throw new Error('run_attempt_already_bound');
    }
    this.runId = runId;
  }

  ignore(): void {
    if (this.runId !== undefined) throw new Error('run_attempt_already_bound');
    this.ignored = true;
  }

  complete(): void {
    if (this.ignored || this.runId === undefined) return;
    try {
      const run = this.runs.get(this.runId);
      if (run?.status !== 'queued') return;
      this.runs.markStarted(run.id);
      this.runs.markFinished(run.id, 'completed');
    } catch {
      // Run auditing must not replace a successful API response with an internal error.
    }
  }

  fail(error: unknown): void {
    if (this.ignored) return;
    try {
      const runId = this.runId ?? this.reserve();
      const run = this.runs.get(runId);
      const errorCode = normalizeOpenAIError(error).code;
      if (run?.status === 'queued') {
        this.runs.markQueuedFinished(run.id, 'failed', errorCode);
      } else if (run?.status === 'running') {
        this.runs.markFinished(run.id, 'failed', errorCode);
      }
    } catch {
      // Preserve the original OpenAI error if auditing is unavailable.
    }
  }
}
