import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type {
  AssistantMessage,
  Event as OpenCodeEvent,
  FilePartInput,
  OpencodeClient,
  Part as OpenCodePart,
  SessionPromptResponse,
  TextPartInput,
} from '@opencode-ai/sdk/v2';
import {
  API_PROVIDER_SYSTEM_INSTRUCTION,
  renderProviderInput,
} from '../provider-input.js';
import { readBoundedLines } from '../process/line-reader.js';
import {
  spawnManagedProcess,
  type SpawnManagedProcess,
} from '../process/managed-process.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../types.js';
import { OpenCodeServer } from './server.js';

const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const NATIVE_ABORT_TIMEOUT_MS = 2_000;
const CONFORMANCE_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string' },
  },
  additionalProperties: false,
};
const validateConformanceOutput = new Ajv2020({ allErrors: false }).compile(CONFORMANCE_SCHEMA);
const SAFE_FINAL_PARTS = new Set([
  'text', 'reasoning', 'step-start', 'step-finish', 'retry', 'compaction',
]);

export type RunOpenCodeCommand = (args: string[]) => Promise<string>;

export interface OpenCodeProviderAdapterOptions {
  server?: OpenCodeServer;
  runCommand?: RunOpenCodeCommand;
  spawnProcess?: SpawnManagedProcess;
  nativeAbortTimeoutMs?: number;
}

interface ActiveRun {
  client: OpencodeClient;
  sessionID: string;
  directory: string;
  sdkCancellation: AbortController;
  abortPromise: Promise<void> | null;
  cancelRequested: boolean;
}

interface TurnEvidence {
  nativeSessionId: string | null;
  text: string;
  structured: string;
  completed: boolean;
  failed: boolean;
}

interface ConformanceEvidence {
  strict: boolean;
  nativeStreaming: boolean;
  structuredOutput: boolean;
  resume: boolean;
}

type StreamOutcome =
  | { kind: 'event'; result: IteratorResult<OpenCodeEvent> }
  | { kind: 'prompt'; result: SessionPromptResponse };

type UnknownRecord = Record<string, unknown>;

export class OpenCodeAdapterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OpenCodeAdapterError';
  }
}

export class ProviderConfigError extends OpenCodeAdapterError {
  constructor(code: string) {
    super(code);
    this.name = 'ProviderConfigError';
  }
}

export function splitOpenCodeModel(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw new ProviderConfigError('invalid_opencode_model');
  }
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  };
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : null;
}

function eventRecord(event: OpenCodeEvent): UnknownRecord {
  return event as unknown as UnknownRecord;
}

function eventProperties(event: OpenCodeEvent): UnknownRecord {
  return asRecord(eventRecord(event).properties) ?? {};
}

function eventDirectory(event: OpenCodeEvent): string | null {
  const record = eventRecord(event);
  if (typeof record.directory === 'string') return record.directory;
  const properties = eventProperties(event);
  if (typeof properties.directory === 'string') return properties.directory;
  const location = asRecord(record.location);
  return typeof location?.directory === 'string' ? location.directory : null;
}

function eventType(event: OpenCodeEvent): string {
  return typeof eventRecord(event).type === 'string' ? String(eventRecord(event).type) : '';
}

function eventAttribution(properties: UnknownRecord): {
  sessionID: unknown;
  messageID: unknown;
} {
  const nested = [
    properties.part,
    properties.permission,
    properties.tool,
    properties.source,
  ].map(asRecord).find((value) => value !== null && typeof value.messageID === 'string');
  return {
    sessionID: properties.sessionID ?? nested?.sessionID,
    messageID: properties.messageID ?? properties.assistantMessageID ?? nested?.messageID,
  };
}

function matchingMessage(
  properties: UnknownRecord,
  sessionID: string,
  messageIDs: ReadonlySet<string>,
): boolean {
  const attribution = eventAttribution(properties);
  return attribution.sessionID === sessionID
    && typeof attribution.messageID === 'string'
    && messageIDs.has(attribution.messageID);
}

function isUnsafeEvent(type: string): boolean {
  return type === 'command.executed'
    || type.startsWith('permission.')
    || type.startsWith('question.')
    || type.startsWith('session.next.tool.')
    || type.startsWith('session.next.shell.')
    || type.startsWith('mcp.')
    || type === 'file.edited'
    || type === 'session.diff';
}

function isDirectoryScopedUnsafeEvent(type: string): boolean {
  return type.startsWith('mcp.') || type === 'file.edited';
}

function matchingUnsafeEvent(
  type: string,
  properties: UnknownRecord,
  sessionID: string,
  messageIDs: ReadonlySet<string>,
  directoryMatches: boolean,
): boolean {
  const attribution = eventAttribution(properties);
  if (typeof attribution.sessionID === 'string') {
    if (attribution.sessionID !== sessionID) return false;
    return typeof attribution.messageID !== 'string'
      || messageIDs.has(attribution.messageID);
  }
  return directoryMatches && isDirectoryScopedUnsafeEvent(type);
}

function isUnsafePart(type: unknown): boolean {
  return type === 'tool'
    || type === 'subtask'
    || type === 'agent'
    || type === 'command'
    || type === 'permission'
    || type === 'file'
    || type === 'patch'
    || type === 'snapshot';
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function assertSafeFinalResult(
  result: SessionPromptResponse,
  sessionID: string,
  userMessageID: string,
  observedAssistantID: string | null,
): AssistantMessage {
  const info = result.info;
  if (info.role !== 'assistant'
    || info.sessionID !== sessionID
    || info.parentID !== userMessageID
    || (observedAssistantID !== null && info.id !== observedAssistantID)) {
    throw new OpenCodeAdapterError('adapter_protocol_error');
  }
  for (const part of result.parts as OpenCodePart[]) {
    if (part.sessionID !== sessionID || part.messageID !== info.id || !SAFE_FINAL_PARTS.has(part.type)) {
      throw new OpenCodeAdapterError('adapter_protocol_error');
    }
  }
  return info;
}

function capabilities(
  version: string,
  modelOptions: ProviderCapabilities['modelOptions'],
  verified: boolean,
  evidence: ConformanceEvidence = {
    strict: true,
    nativeStreaming: true,
    structuredOutput: true,
    resume: true,
  },
): ProviderCapabilities {
  return {
    available: true,
    version,
    verified,
    ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
    modelSelection: true,
    effortSelection: true,
    modelOptions,
    isolationLevel: evidence.strict ? 'strict' : 'best_effort',
    streamingMode: evidence.nativeStreaming ? 'native' : 'none',
    toolBridge: evidence.structuredOutput ? 'structured_output' : 'none',
    resume: evidence.resume,
    cancellation: true,
  };
}

function unavailable(error: string): ProviderCapabilities {
  return {
    available: false,
    verified: false,
    modelSelection: false,
    effortSelection: false,
    isolationLevel: 'best_effort',
    streamingMode: 'none',
    toolBridge: 'none',
    resume: false,
    cancellation: false,
    error,
  };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof OpenCodeAdapterError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error')) {
    return String(error.code);
  }
  return 'capability_probe_failed';
}

function failureEvent(error: unknown, nativeStateAdvanced: boolean): ProviderEvent {
  const processFailure = typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error');
  return {
    type: 'failed',
    code: processFailure ? 'adapter_process_error' : 'adapter_protocol_error',
    message: processFailure
      ? 'OpenCode provider process error'
      : 'OpenCode provider protocol error',
    nativeStateAdvanced,
  };
}

export class OpenCodeProviderAdapter implements ProviderAdapter {
  private readonly server: OpenCodeServer;
  private readonly runCommand: RunOpenCodeCommand;
  private readonly nativeAbortTimeoutMs: number;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: OpenCodeProviderAdapterOptions = {}) {
    this.server = options.server ?? new OpenCodeServer();
    const spawnProcess = options.spawnProcess ?? spawnManagedProcess;
    this.runCommand = options.runCommand ?? ((args) => this.runCliCommand(spawnProcess, args));
    this.nativeAbortTimeoutMs = options.nativeAbortTimeoutMs ?? NATIVE_ABORT_TIMEOUT_MS;
  }

  async probeCapabilities(
    request: ProviderProbeRequest = { mode: 'static' },
  ): Promise<ProviderCapabilities> {
    try {
      const metadata = await this.staticMetadata();
      if (request.mode === 'static') {
        return capabilities(metadata.version, metadata.models, false);
      }
      const evidence = await this.verifyConformance(request);
      return capabilities(metadata.version, metadata.models, true, evidence);
    } catch (error) {
      return unavailable(safeErrorCode(error));
    }
  }

  start(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    return this.stream(request, null);
  }

  resume(request: ProviderResumeRequest): AsyncIterable<ProviderEvent> {
    return this.stream(request, request.nativeSessionId);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancelRequested = true;
    active.sdkCancellation.abort();
    active.abortPromise ??= this.abortNative(active);
    await active.abortPromise;
  }

  async dispose(): Promise<void> {
    await this.server.close();
  }

  private async *stream(
    request: ProviderRequest,
    resumeSessionID: string | null,
  ): AsyncGenerator<ProviderEvent> {
    if (request.signal.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    let sessionID: string | null = resumeSessionID;
    let createdSession = false;
    let deletedSession = false;
    let nativeStateAdvanced = false;
    let active: ActiveRun | null = null;
    let client: OpencodeClient | null = null;
    let eventIterator: AsyncIterator<OpenCodeEvent> | null = null;
    let cancellationRequested = false;
    const sdkCancellation = new AbortController();
    const onAbort = () => {
      cancellationRequested = true;
      sdkCancellation.abort(request.signal.reason);
      void this.cancel(request.runId).catch(() => undefined);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    try {
      const model = splitOpenCodeModel(request.model);
      const promptText = renderProviderInput(request.input);
      const validateStructured = request.outputSchema === null
        ? null
        : new Ajv2020({ allErrors: false }).compile(request.outputSchema);
      const server = await waitForSignal(this.server.start(), sdkCancellation.signal);
      client = server.client;
      const subscription = await client.event.subscribe(
        { directory: request.workspace },
        { signal: sdkCancellation.signal },
      );
      eventIterator = subscription.stream[Symbol.asyncIterator]();

      if (sessionID === null) {
        const created = await client.session.create(
          { directory: request.workspace },
          { throwOnError: true, signal: sdkCancellation.signal },
        );
        sessionID = created.data.id;
        createdSession = true;
      }

      active = {
        client,
        sessionID,
        directory: request.workspace,
        sdkCancellation,
        abortPromise: null,
        cancelRequested: false,
      };
      this.activeRuns.set(request.runId, active);
      nativeStateAdvanced = true;
      if (request.signal.aborted) {
        cancellationRequested = true;
        await this.cancel(request.runId);
      }
      yield { type: 'session_started', nativeSessionId: sessionID };
      if (request.signal.aborted || active.cancelRequested) {
        yield { type: 'cancelled' };
        return;
      }

      const userMessageID = randomUUID();
      let nextEvent = eventIterator.next();
      const parts: Array<TextPartInput | FilePartInput> = [
        { type: 'text', text: promptText },
        ...(request.images ?? []).map((image): FilePartInput => ({
          type: 'file',
          mime: image.mediaType,
          filename: basename(image.path),
          url: pathToFileURL(image.path).href,
        })),
      ];
      const prompt = client.session.prompt({
        sessionID,
        directory: request.workspace,
        messageID: userMessageID,
        model,
        ...(request.effort === null ? {} : { variant: request.effort }),
        system: API_PROVIDER_SYSTEM_INSTRUCTION,
        parts,
        format: request.outputSchema
          ? { type: 'json_schema', schema: request.outputSchema, retryCount: 2 }
          : { type: 'text' },
      }, {
        throwOnError: true,
        signal: sdkCancellation.signal,
      }).then((response) => response.data);

      let finalResult: SessionPromptResponse | null = null;
      let assistantMessageID: string | null = null;
      let sawAssistantTerminal = false;
      const seenEventIDs = new Set<string>();
      while (finalResult === null || !sawAssistantTerminal) {
        const outcome: StreamOutcome = finalResult === null
          ? await Promise.race([
              nextEvent.then((result) => ({ kind: 'event' as const, result })),
              prompt.then((result) => ({ kind: 'prompt' as const, result })),
            ])
          : { kind: 'event' as const, result: await nextEvent };
        if (outcome.kind === 'prompt') {
          finalResult = outcome.result;
          continue;
        }
        if (outcome.result.done) throw new OpenCodeAdapterError('adapter_protocol_error');

        const event = outcome.result.value;
        const directory = eventDirectory(event);
        if (directory !== null && directory !== request.workspace) {
          nextEvent = eventIterator.next();
          continue;
        }
        const type = eventType(event);
        const properties = eventProperties(event);

        if (type === 'message.updated') {
          const info = asRecord(properties.info);
          if (properties.sessionID === sessionID
            && info?.role === 'assistant'
            && info.sessionID === sessionID
            && info.parentID === userMessageID
            && typeof info.id === 'string') {
            assistantMessageID = info.id;
            const time = asRecord(info.time);
            if (typeof time?.completed === 'number') sawAssistantTerminal = true;
          }
        } else {
          const messageIDs = new Set<string>([userMessageID]);
          if (assistantMessageID) messageIDs.add(assistantMessageID);
          if (isUnsafeEvent(type) && matchingUnsafeEvent(
            type,
            properties,
            sessionID,
            messageIDs,
            directory === null || directory === request.workspace,
          )) {
            throw new OpenCodeAdapterError('adapter_protocol_error');
          }
          if (type === 'message.part.updated') {
            const part = asRecord(properties.part);
            if (part && matchingMessage(properties, sessionID, messageIDs)) {
              if (part.type !== 'text') {
                if (isUnsafePart(part.type)) {
                  throw new OpenCodeAdapterError('adapter_protocol_error');
                }
              } else if (request.outputSchema === null
                && part.messageID === assistantMessageID
                && typeof properties.delta === 'string'
                && properties.delta.length > 0) {
                const eventID = eventRecord(event).id;
                if (typeof eventID !== 'string' || !seenEventIDs.has(eventID)) {
                  if (typeof eventID === 'string') seenEventIDs.add(eventID);
                  yield { type: 'text_delta', delta: properties.delta };
                }
              }
            }
          }
        }
        if (sawAssistantTerminal && finalResult === null) {
          finalResult = await prompt;
        } else if (!sawAssistantTerminal) {
          nextEvent = eventIterator.next();
        }
      }

      const finalInfo = assertSafeFinalResult(
        finalResult,
        sessionID,
        userMessageID,
        assistantMessageID,
      );
      if (finalInfo.error) {
        yield {
          type: 'failed',
          code: 'adapter_provider_failed',
          message: 'OpenCode provider turn failed',
          nativeStateAdvanced: true,
        };
        return;
      }

      if (request.outputSchema !== null) {
        if (validateStructured === null || !validateStructured(finalInfo.structured)) {
          throw new OpenCodeAdapterError('adapter_protocol_error');
        }
        const structured = JSON.stringify(finalInfo.structured);
        if (structured === undefined) throw new OpenCodeAdapterError('adapter_protocol_error');
        yield { type: 'structured_delta', delta: structured };
      }

      if (createdSession && request.sessionMode === 'ephemeral') {
        await client.session.delete({
          sessionID,
          directory: request.workspace,
        }, { throwOnError: true });
        deletedSession = true;
      }
      yield { type: 'completed' };
    } catch (error) {
      if (cancellationRequested || active?.cancelRequested) {
        yield { type: 'cancelled' };
      } else {
        yield failureEvent(error, nativeStateAdvanced);
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (active && this.activeRuns.get(request.runId) === active) {
        this.activeRuns.delete(request.runId);
      }
      try {
        await eventIterator?.return?.();
      } catch {
        // The SSE iterator owns its cleanup error; run outcome is already settled.
      }
      if (createdSession && request.sessionMode === 'ephemeral'
        && !deletedSession && sessionID !== null && client !== null) {
        try {
          await client.session.delete({
            sessionID,
            directory: request.workspace,
          }, { throwOnError: true });
        } catch {
          // Best-effort cleanup must not expose provider or SDK details.
        }
      }
    }
  }

  private async abortNative(active: ActiveRun): Promise<void> {
    const timeout = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        timeout.abort();
        resolve('timeout');
      }, this.nativeAbortTimeoutMs);
      timer.unref();
    });
    const request = active.client.session.abort({
      sessionID: active.sessionID,
      directory: active.directory,
    }, {
      throwOnError: true,
      signal: timeout.signal,
    }).then(
      () => ({ kind: 'completed' as const }),
      (error: unknown) => ({ kind: 'failed' as const, error }),
    );

    try {
      const outcome = await Promise.race([request, deadline]);
      if (outcome !== 'timeout' && outcome.kind === 'failed') throw outcome.error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async staticMetadata(): Promise<{
    version: string;
    models: NonNullable<ProviderCapabilities['modelOptions']>;
  }> {
    const versionOutput = await this.runCommand(['--version']);
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new OpenCodeAdapterError('adapter_protocol_error');

    const modelOutput = await this.runCommand(['models']);
    const ids = [...new Set(modelOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (ids.length === 0) throw new OpenCodeAdapterError('adapter_protocol_error');
    for (const id of ids) splitOpenCodeModel(id);
    return {
      version,
      models: ids.map((id) => ({ id, label: id, effortOptions: null })),
    };
  }

  private async runCliCommand(spawnProcess: SpawnManagedProcess, args: string[]): Promise<string> {
    const managed = spawnProcess({
      command: 'opencode',
      args,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    try {
      let output = '';
      const collect = (async () => {
        for await (const line of readBoundedLines(managed.stdout)) {
          output += `${line}\n`;
          if (Buffer.byteLength(output) > COMMAND_OUTPUT_LIMIT_BYTES) {
            throw new OpenCodeAdapterError('adapter_protocol_error');
          }
        }
      })();
      const [exit] = await Promise.all([managed.exited, collect]);
      if (exit.code !== 0 || output.trim().length === 0) {
        throw Object.assign(new Error('adapter_process_error'), { code: 'adapter_process_error' });
      }
      return output.trim();
    } finally {
      try {
        await managed.dispose();
      } catch {
        // The CLI probe may exit before process-group cleanup completes.
      }
    }
  }

  private async verifyConformance(
    request: Extract<ProviderProbeRequest, { mode: 'conformance' }>,
  ): Promise<ConformanceEvidence> {
    const baseRequest: ProviderRequest = {
      runId: `opencode-conformance-text-${randomUUID()}`,
      targetId: request.targetId,
      model: request.model,
      effort: request.effort,
      workspace: request.workspace,
      input: [{ role: 'user', content: 'Return a short text confirmation.' }],
      sessionMode: 'persistent',
      runTimeoutMs: null,
      outputSchema: null,
      signal: request.signal,
    };
    const text = await this.observeTurn(this.start(baseRequest));
    const schema = await this.observeTurn(this.start({
      ...baseRequest,
      runId: `opencode-conformance-schema-${randomUUID()}`,
      input: [{
        role: 'user',
        content: 'Return JSON with type "assistant_text" and a short confirmation in content.',
      }],
      outputSchema: CONFORMANCE_SCHEMA,
    }));
    const resumed = text.nativeSessionId === null
      ? null
      : await this.observeTurn(this.resume({
          ...baseRequest,
          runId: `opencode-conformance-resume-${randomUUID()}`,
          nativeSessionId: text.nativeSessionId,
          input: [{ role: 'user', content: 'Return another short text confirmation.' }],
        }));

    let validStructuredOutput = false;
    if (schema.completed && !schema.failed) {
      try {
        validStructuredOutput = validateConformanceOutput(JSON.parse(schema.structured));
      } catch {
        validStructuredOutput = false;
      }
    }
    const nativeStreaming = text.completed && !text.failed && text.text.length > 0
      && resumed !== null && resumed.completed && !resumed.failed && resumed.text.length > 0;
    const safeTurns = !text.failed && !schema.failed && resumed !== null && !resumed.failed;
    return {
      strict: safeTurns && text.completed && schema.completed && resumed.completed,
      nativeStreaming,
      structuredOutput: validStructuredOutput,
      resume: resumed !== null && resumed.completed && !resumed.failed,
    };
  }

  private async observeTurn(events: AsyncIterable<ProviderEvent>): Promise<TurnEvidence> {
    const evidence: TurnEvidence = {
      nativeSessionId: null,
      text: '',
      structured: '',
      completed: false,
      failed: false,
    };
    for await (const event of events) {
      if (event.type === 'session_started') evidence.nativeSessionId = event.nativeSessionId;
      else if (event.type === 'text_delta') evidence.text += event.delta;
      else if (event.type === 'structured_delta') evidence.structured += event.delta;
      else if (event.type === 'completed') evidence.completed = true;
      else evidence.failed = true;
    }
    return evidence;
  }
}
