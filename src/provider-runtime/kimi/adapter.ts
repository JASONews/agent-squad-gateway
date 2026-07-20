import { readFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  ClientContext,
  ContentBlock,
  InitializeResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  API_PROVIDER_SYSTEM_INSTRUCTION,
  renderProviderInput,
} from '../provider-input.js';
import { readBoundedLines } from '../process/line-reader.js';
import {
  spawnManagedProcess,
  type ManagedProcess,
  type SpawnManagedProcess,
} from '../process/managed-process.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderModelOption,
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../types.js';
import { AGENT_SQUAD_GATEWAY_VERSION } from '../../version.js';

const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_EFFORT_OPTIONS = ['off', 'on'];
const PROCESS_EXIT_CLASSIFICATION_MS = 25;
const STATIC_PROBE_TIMEOUT_MS = 5_000;
const CONFORMANCE_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
};
const conformanceOutputSchema = z.object({
  type: z.literal('assistant_text'),
  content: z.string().min(1),
}).strict();

export const KIMI_ISOLATION_WARNING = [
  'Kimi Code ACP receives no MCP servers or client filesystem/terminal capabilities, rejects all permission requests,',
  'and fails on tool updates, but Kimi shell execution remains local to the CLI; isolation is best effort.',
].join(' ');

export const KIMI_SESSION_RETENTION_WARNING = [
  'Kimi Code ACP does not advertise session deletion, so ephemeral Gateway calls can remain',
  'in local Kimi session history.',
].join(' ');

export interface KimiProviderAdapterOptions {
  spawnProcess?: SpawnManagedProcess;
  command?: string;
  env?: NodeJS.ProcessEnv;
  staticProbeTimeoutMs?: number;
}

interface ActiveRun {
  process: ManagedProcess;
  context: ClientContext | null;
  sessionId: string | null;
  cancellationRequested: boolean;
  cancelSent: boolean;
}

interface StreamObservation {
  textChunks: number;
  models: Map<string, string>;
  efforts: Map<string, string>;
}

interface ConformanceResult {
  models: ProviderModelOption[];
}

class KimiAdapterError extends Error {
  constructor(readonly code: 'adapter_protocol_error' | 'adapter_capability_unsupported') {
    super(code);
    this.name = 'KimiAdapterError';
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve(value: T | null): void;
    reject(error: unknown): void;
  }> = [];
  private terminal: { error: unknown } | { error: null } | null = null;

  push(value: T): void {
    if (this.terminal !== null) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  end(): void {
    if (this.terminal !== null) return;
    this.terminal = { error: null };
    for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
  }

  fail(error: unknown): void {
    if (this.terminal !== null) return;
    this.terminal = { error };
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async take(): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.terminal !== null) {
      if (this.terminal.error !== null) throw this.terminal.error;
      return null;
    }
    return new Promise<T | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function capabilities(
  version: string,
  verified: boolean,
  models = defaultModelOptions(),
): ProviderCapabilities {
  return {
    available: true,
    version,
    verified,
    ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
    modelSelection: true,
    effortSelection: true,
    modelOptions: models,
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    details: [KIMI_ISOLATION_WARNING, KIMI_SESSION_RETENTION_WARNING],
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

function defaultModelOptions(): ProviderModelOption[] {
  return [{
    id: 'default',
    label: 'Kimi Code default',
    effortOptions: [...DEFAULT_EFFORT_OPTIONS],
  }];
}

function safeProbeError(error: unknown): string {
  if (error instanceof KimiAdapterError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error')) {
    return String(error.code);
  }
  return 'capability_probe_failed';
}

function failureEvent(error: unknown, nativeStateAdvanced: boolean): ProviderEvent {
  const code = error instanceof KimiAdapterError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error')
      ? String(error.code)
      : 'adapter_protocol_error';
  return {
    type: 'failed',
    code,
    message: code === 'adapter_capability_unsupported'
      ? 'Kimi provider capability unsupported'
      : code === 'adapter_protocol_error'
        ? 'Kimi provider protocol error'
        : 'Kimi provider process error',
    nativeStateAdvanced,
  };
}

function processError(process: ManagedProcess, code: 'adapter_process_error'): Error {
  const diagnostic = process.stderrDiagnostic().trim();
  return Object.assign(new Error(diagnostic || code), { code });
}

async function disposeQuietly(process: ManagedProcess): Promise<void> {
  try {
    await process.dispose();
  } catch {
    // The ACP process may exit while connection cleanup is in progress.
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new KimiAdapterError('adapter_protocol_error');
  return encoded;
}

function renderPrompt(request: ProviderRequest): string {
  const sections = [
    API_PROVIDER_SYSTEM_INSTRUCTION,
    renderProviderInput(request.input),
  ];
  if (request.outputSchema !== null) {
    sections.push([
      'Return exactly one raw JSON value that validates against the following JSON Schema.',
      `JSON Schema: ${canonicalJson(request.outputSchema)}`,
      'Do not include Markdown fences, commentary, reasoning, or any text outside that JSON value.',
    ].join('\n'));
  }
  return sections.join('\n\n');
}

function configMatches(
  option: SessionConfigOption,
  category: string,
  namePattern: RegExp,
): boolean {
  return option.type === 'select'
    && (option.category === category || namePattern.test(`${option.id} ${option.name}`));
}

function findModelConfig(options: SessionConfigOption[]): SessionConfigOption | null {
  return options.find((option) => configMatches(option, 'model', /\bmodel\b/i)) ?? null;
}

function findEffortConfig(options: SessionConfigOption[]): SessionConfigOption | null {
  return options.find((option) => configMatches(
    option,
    'thought_level',
    /\b(?:thinking|thought|reasoning|effort)\b/i,
  )) ?? null;
}

function selectValues(option: SessionConfigOption | null): Array<{ value: string; name: string }> {
  if (option?.type !== 'select') return [];
  return option.options.flatMap((entry) => 'options' in entry ? entry.options : [entry]);
}

function resolveConfigValue(
  option: SessionConfigOption,
  requested: string,
  kind: 'effort',
): string {
  const values = selectValues(option);
  const normalized = requested.toLocaleLowerCase();
  const exact = values.find((candidate) => candidate.value === requested)
    ?? values.find((candidate) => candidate.name.toLocaleLowerCase() === normalized);
  if (exact) return exact.value;
  if (kind === 'effort') {
    const enabled = values.find((candidate) => candidate.value === 'on');
    const disabled = values.find((candidate) => candidate.value === 'off');
    if (enabled && disabled) {
      return ['off', 'none', 'false', 'disabled'].includes(normalized)
        ? disabled.value
        : enabled.value;
    }
  }
  return requested;
}

function observeConfig(
  options: SessionConfigOption[],
  observation?: StreamObservation,
  includeEfforts = true,
): void {
  if (!observation) return;
  for (const value of selectValues(findModelConfig(options))) {
    observation.models.set(value.value, value.name);
  }
  if (includeEfforts) {
    for (const value of selectValues(findEffortConfig(options))) {
      observation.efforts.set(value.value, value.name);
    }
  }
}

function conformanceModels(
  observation: StreamObservation,
  verifiedModel: string,
): ProviderModelOption[] {
  const efforts = [...observation.efforts.keys()];
  const selectedEfforts = efforts.length > 0 ? [...efforts] : null;
  const result: ProviderModelOption[] = [{
    id: 'default',
    label: 'Kimi Code default',
    effortOptions: verifiedModel === 'default' ? selectedEfforts : null,
  }];
  for (const [id, label] of observation.models) {
    if (id !== 'default') {
      result.push({ id, label, effortOptions: id === verifiedModel ? selectedEfforts : null });
    }
  }
  return result;
}

function rejectPermission(request: RequestPermissionRequest): RequestPermissionResponse {
  const rejection = request.options.find((option) => option.kind === 'reject_always')
    ?? request.options.find((option) => option.kind === 'reject_once');
  return rejection
    ? { outcome: { outcome: 'selected', optionId: rejection.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function initialClientCapabilities(): acp.ClientCapabilities {
  return {
    session: { configOptions: {} },
  };
}

export class KimiProviderAdapter implements ProviderAdapter {
  private readonly spawnProcess: SpawnManagedProcess;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly staticProbeTimeoutMs: number;
  private readonly launchCwd = process.cwd();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: KimiProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnManagedProcess;
    this.command = options.command ?? 'kimi';
    this.env = options.env ?? { ...process.env };
    this.staticProbeTimeoutMs = options.staticProbeTimeoutMs ?? STATIC_PROBE_TIMEOUT_MS;
  }

  async probeCapabilities(
    request: ProviderProbeRequest = { mode: 'static' },
  ): Promise<ProviderCapabilities> {
    try {
      const version = await this.staticMetadata();
      if (request.mode === 'static') return capabilities(version, false);
      const result = await this.verifyConformance(request);
      return capabilities(version, true, result.models);
    } catch (error) {
      return unavailable(safeProbeError(error));
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
    active.cancellationRequested = true;
    if (!active.cancelSent && active.context && active.sessionId) {
      active.cancelSent = true;
      try {
        await active.context.notify(acp.methods.agent.session.cancel, {
          sessionId: active.sessionId,
        });
      } catch {
        // Process interruption below remains the cancellation backstop.
      }
    }
    await active.process.interrupt();
  }

  private async *stream(
    request: ProviderRequest,
    requestedSessionId: string | null,
    observation?: StreamObservation,
  ): AsyncGenerator<ProviderEvent> {
    if (request.signal.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    const queue = new AsyncEventQueue<ProviderEvent>();
    let managed: ManagedProcess | null = null;
    let active: ActiveRun | null = null;
    let producer: Promise<void> | null = null;
    let producerSettled = false;
    let nativeStateAdvanced = false;
    let protocolViolation = false;
    let turnTerminal = false;
    const onAbort = () => { void this.cancel(request.runId).catch(() => undefined); };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      managed = this.spawnProcess({
        command: this.command,
        args: ['acp'],
        cwd: request.workspace,
        env: { ...this.env },
      });
      active = {
        process: managed,
        context: null,
        sessionId: null,
        cancellationRequested: false,
        cancelSent: false,
      };
      this.activeRuns.set(request.runId, active);

      const output = Writable.toWeb(managed.stdin as Writable);
      const input = Readable.toWeb(managed.stdout as Readable) as ReadableStream<Uint8Array>;
      const transport = acp.ndJsonStream(output, input);
      const app = acp.client({ name: 'agent-squad-gateway' })
        .onRequest(acp.methods.client.session.requestPermission, (context) => (
          rejectPermission(context.params)
        ))
        .onNotification(acp.methods.client.session.update, (context) => {
          const update = context.params.update;
          if (context.params.sessionId !== active?.sessionId) {
            protocolViolation = true;
            queue.fail(new KimiAdapterError('adapter_protocol_error'));
            return;
          }
          if (update.sessionUpdate === 'tool_call'
            || update.sessionUpdate === 'tool_call_update') {
            protocolViolation = true;
            queue.fail(new KimiAdapterError('adapter_protocol_error'));
            if (active && !active.cancelSent) {
              active.cancelSent = true;
              void context.agent.notify(acp.methods.agent.session.cancel, {
                sessionId: context.params.sessionId,
              }).catch(() => undefined);
            }
            return;
          }
          if (update.sessionUpdate === 'agent_message_chunk'
            && update.content.type === 'text') {
            observation && (observation.textChunks += 1);
            queue.push(request.outputSchema === null
              ? { type: 'text_delta', delta: update.content.text }
              : { type: 'structured_delta', delta: update.content.text });
          }
        });

      producer = app.connectWith(transport, async (context) => {
        if (!active) throw new KimiAdapterError('adapter_protocol_error');
        active.context = context;
        const init = await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: initialClientCapabilities(),
          clientInfo: {
            name: 'agent-squad-gateway',
            title: 'Agent Squad Gateway',
            version: AGENT_SQUAD_GATEWAY_VERSION,
          },
        }, { cancellationSignal: request.signal });
        this.validateInitialize(init, request);

        let sessionId: string;
        let configOptions: SessionConfigOption[];
        if (requestedSessionId === null) {
          const session = await context.request(acp.methods.agent.session.new, {
            cwd: request.workspace,
            mcpServers: [],
          }, { cancellationSignal: request.signal });
          sessionId = session.sessionId;
          configOptions = session.configOptions ?? [];
        } else {
          const session = await context.request(acp.methods.agent.session.resume, {
            sessionId: requestedSessionId,
            cwd: request.workspace,
            mcpServers: [],
          }, { cancellationSignal: request.signal });
          sessionId = requestedSessionId;
          configOptions = session.configOptions ?? [];
        }
        if (sessionId.length === 0) throw new KimiAdapterError('adapter_protocol_error');
        active.sessionId = sessionId;
        queue.push({ type: 'session_started', nativeSessionId: sessionId });

        observeConfig(configOptions, observation, false);
        configOptions = await this.applyConfig(context, sessionId, configOptions, request);
        observeConfig(configOptions, observation);

        const prompt = await this.promptBlocks(request);
        nativeStateAdvanced = true;
        const response = await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt,
        }, { cancellationSignal: request.signal });
        if (protocolViolation) throw new KimiAdapterError('adapter_protocol_error');
        if (response.stopReason === 'cancelled' || active.cancellationRequested) {
          turnTerminal = true;
          queue.push({ type: 'cancelled' });
          return;
        }
        if (response.stopReason !== 'end_turn') {
          throw new KimiAdapterError('adapter_protocol_error');
        }
        turnTerminal = true;
        queue.push({ type: 'completed' });

        if (request.sessionMode === 'ephemeral'
          && init.agentCapabilities?.sessionCapabilities?.delete) {
          try {
            await context.request(acp.methods.agent.session.delete, { sessionId });
          } catch {
            // Ephemeral cleanup is best effort because Kimi may retain session history.
          }
        }
      });
      void producer.then(
        () => { producerSettled = true; queue.end(); },
        async (error) => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_EXIT_CLASSIFICATION_MS));
          producerSettled = true;
          queue.fail(error);
        },
      );
      void managed.exited.then(
        (exit) => {
          if (producerSettled || turnTerminal || active?.cancellationRequested) return;
          queue.fail(exit.code === 0
            ? new KimiAdapterError('adapter_protocol_error')
            : processError(managed!, 'adapter_process_error'));
        },
        (error) => queue.fail(error),
      );

      for (;;) {
        const event = await queue.take();
        if (event === null) break;
        yield event;
      }
    } catch (error) {
      if (!protocolViolation && (request.signal.aborted || active?.cancellationRequested)) {
        yield { type: 'cancelled' };
      } else {
        yield failureEvent(error, nativeStateAdvanced);
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (!producerSettled && active?.context && active.sessionId && !active.cancelSent) {
        active.cancelSent = true;
        try {
          await active.context.notify(acp.methods.agent.session.cancel, {
            sessionId: active.sessionId,
          });
        } catch {
          // The ACP connection may already be closed.
        }
      }
      if (active && this.activeRuns.get(request.runId) === active) {
        this.activeRuns.delete(request.runId);
      }
      if (managed) await disposeQuietly(managed);
      if (producer) await producer.catch(() => undefined);
    }
  }

  private validateInitialize(init: InitializeResponse, request: ProviderRequest): void {
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new KimiAdapterError('adapter_capability_unsupported');
    }
    const sessions = init.agentCapabilities?.sessionCapabilities;
    if (!sessions?.resume) throw new KimiAdapterError('adapter_capability_unsupported');
    if (init.agentCapabilities?.promptCapabilities?.image !== true) {
      throw new KimiAdapterError('adapter_capability_unsupported');
    }
  }

  private async applyConfig(
    context: ClientContext,
    sessionId: string,
    options: SessionConfigOption[],
    request: ProviderRequest,
  ): Promise<SessionConfigOption[]> {
    let current = options;
    if (request.model !== 'default') {
      const model = findModelConfig(current);
      if (!model) throw new KimiAdapterError('adapter_capability_unsupported');
      const response = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: model.id,
        value: request.model,
      }, { cancellationSignal: request.signal });
      current = response.configOptions;
    }
    if (request.effort !== null && request.effort !== 'default') {
      const effort = findEffortConfig(current);
      if (!effort) throw new KimiAdapterError('adapter_capability_unsupported');
      const response = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: effort.id,
        value: resolveConfigValue(effort, request.effort, 'effort'),
      }, { cancellationSignal: request.signal });
      current = response.configOptions;
    }
    return current;
  }

  private async promptBlocks(request: ProviderRequest): Promise<ContentBlock[]> {
    const blocks: ContentBlock[] = [{ type: 'text', text: renderPrompt(request) }];
    for (const image of request.images ?? []) {
      blocks.push({
        type: 'image',
        data: (await readFile(image.path)).toString('base64'),
        mimeType: image.mediaType,
      });
    }
    return blocks;
  }

  private async staticMetadata(): Promise<string> {
    const versionOutput = await this.runCommand(['--version']);
    const helpOutput = await this.runCommand(['--help']);
    if (!/\bacp\b/i.test(helpOutput)) {
      throw new KimiAdapterError('adapter_capability_unsupported');
    }
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new KimiAdapterError('adapter_protocol_error');
    return version;
  }

  private async runCommand(args: string[]): Promise<string> {
    const managed = this.spawnProcess({
      command: this.command,
      args,
      cwd: this.launchCwd,
      env: { ...this.env },
    });
    managed.stdin.end();
    let timeout: NodeJS.Timeout | undefined;
    try {
      let output = '';
      const collect = (async () => {
        for await (const line of readBoundedLines(managed.stdout)) {
          output += `${line}\n`;
          if (Buffer.byteLength(output) > COMMAND_OUTPUT_LIMIT_BYTES) {
            throw new KimiAdapterError('adapter_protocol_error');
          }
        }
      })();
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void managed.interrupt(0).then(
            () => reject(new KimiAdapterError('adapter_protocol_error')),
            () => reject(new KimiAdapterError('adapter_protocol_error')),
          );
        }, this.staticProbeTimeoutMs);
      });
      const [exit] = await Promise.race([
        Promise.all([managed.exited, collect]),
        timedOut,
      ]);
      const combined = [output.trim(), managed.stderrDiagnostic().trim()]
        .filter(Boolean)
        .join('\n');
      if (exit.code !== 0 || combined.length === 0) {
        throw processError(managed, 'adapter_process_error');
      }
      return combined;
    } finally {
      if (timeout) clearTimeout(timeout);
      await disposeQuietly(managed);
    }
  }

  private async verifyConformance(
    request: Extract<ProviderProbeRequest, { mode: 'conformance' }>,
  ): Promise<ConformanceResult> {
    const base: ProviderRequest = {
      runId: `kimi-conformance-start-${Date.now()}`,
      targetId: request.targetId,
      model: request.model,
      effort: request.effort,
      workspace: request.workspace,
      input: [{
        role: 'user',
        content: 'Return an assistant_text JSON object with a short English confirmation.',
      }],
      sessionMode: 'persistent',
      runTimeoutMs: null,
      outputSchema: CONFORMANCE_SCHEMA,
      signal: request.signal,
    };
    const first = this.newObservation();
    const nativeSessionId = await this.requireConformance(
      this.stream(base, null, first),
      first,
    );
    const resumed = this.newObservation();
    await this.requireConformance(this.stream({
      ...base,
      runId: `kimi-conformance-resume-${Date.now()}`,
      input: [{
        role: 'user',
        content: 'Return another assistant_text JSON object with a short English confirmation.',
      }],
    }, nativeSessionId, resumed), resumed);
    for (const [id, label] of resumed.models) first.models.set(id, label);
    for (const [id, label] of resumed.efforts) first.efforts.set(id, label);
    return { models: conformanceModels(first, request.model) };
  }

  private newObservation(): StreamObservation {
    return { textChunks: 0, models: new Map(), efforts: new Map() };
  }

  private async requireConformance(
    events: AsyncIterable<ProviderEvent>,
    observation: StreamObservation,
  ): Promise<string> {
    let sessionId: string | null = null;
    let output = '';
    let completed = false;
    for await (const event of events) {
      if (event.type === 'session_started') sessionId = event.nativeSessionId;
      else if (event.type === 'structured_delta') output += event.delta;
      else if (event.type === 'completed') completed = true;
      else if (event.type === 'failed' && event.code === 'adapter_capability_unsupported') {
        throw new KimiAdapterError('adapter_capability_unsupported');
      }
      else throw new KimiAdapterError('adapter_protocol_error');
    }
    if (!sessionId || !completed || observation.textChunks < 1) {
      throw new KimiAdapterError('adapter_protocol_error');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new KimiAdapterError('adapter_protocol_error');
    }
    if (!conformanceOutputSchema.safeParse(parsed).success) {
      throw new KimiAdapterError('adapter_protocol_error');
    }
    return sessionId;
  }
}
