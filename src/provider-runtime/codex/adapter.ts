import Ajv2020 from 'ajv/dist/2020.js';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderEvent,
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../types.js';
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
import { CodexJsonRpcClient } from './json-rpc-client.js';
import {
  CodexAdapterError,
  CODEX_IGNORED_NOTIFICATION_METHODS,
  parseModelListResult,
  parseThreadResult,
  parseTurnResult,
  type CodexModelListResult,
  type CodexNotification,
  type CodexThreadResult,
  type CodexTurnResult,
} from './protocol.js';

const CLIENT_INFO = {
  name: 'agent-squad-gateway',
  title: 'agent-squad-gateway',
  version: '0.1.0',
} as const;
const INTERRUPT_TIMEOUT_MS = 2_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const SAFE_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'userMessage']);
const CONFORMANCE_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { type: 'string', const: 'assistant_text' },
    content: { type: 'string' },
  },
  additionalProperties: false,
};
const validateConformanceOutput = new Ajv2020({ allErrors: false }).compile(CONFORMANCE_SCHEMA);

async function collectCommandOutput(stream: NodeJS.ReadableStream): Promise<string> {
  let output = '';
  for await (const line of readBoundedLines(stream)) {
    output += `${line}\n`;
    if (Buffer.byteLength(output) > COMMAND_OUTPUT_LIMIT_BYTES) {
      throw new CodexAdapterError('adapter_protocol_error');
    }
  }
  return output;
}

interface CodexProviderAdapterOptions {
  spawnProcess?: SpawnManagedProcess;
}

interface AppServerState {
  process: ManagedProcess;
  client: CodexJsonRpcClient;
}

interface ActiveRun {
  client: CodexJsonRpcClient;
  threadId: string;
  turnId: string;
  terminal: Promise<void>;
  resolveTerminal(): void;
  cancelRequested: boolean;
}

function deferred(): Pick<ActiveRun, 'terminal' | 'resolveTerminal'> {
  let resolveTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  return { terminal, resolveTerminal };
}

function baseCapabilities(
  version: string,
  models: CodexModelListResult,
  verified: boolean,
): ProviderCapabilities {
  return {
    available: true,
    version,
    verified,
    ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
    modelSelection: true,
    effortSelection: true,
    modelOptions: models.data.map((model) => ({
      id: model.id,
      label: model.displayName,
      effortOptions: model.supportedReasoningEfforts === null
        ? null
        : [...model.supportedReasoningEfforts],
    })),
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
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

function failureEvent(error: unknown, nativeStateAdvanced: boolean): ProviderEvent {
  const code = error instanceof CodexAdapterError ? error.code : 'adapter_protocol_error';
  return {
    type: 'failed',
    code,
    message: code === 'adapter_process_error' ? 'provider process error' : 'provider protocol error',
    nativeStateAdvanced,
  };
}

function safeProbeError(error: unknown): string {
  if (error instanceof CodexAdapterError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error')) {
    return error.code;
  }
  return 'capability_probe_failed';
}

async function disposeQuietly(managed: ManagedProcess): Promise<void> {
  try {
    await managed.dispose();
  } catch {
    // The child may have exited between observation and process-group cleanup.
  }
}

export class CodexProviderAdapter implements ProviderAdapter {
  private readonly spawnProcess: SpawnManagedProcess;
  private readonly launchCwd = process.cwd();
  private state: AppServerState | null = null;
  private starting: Promise<AppServerState> | null = null;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: CodexProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnManagedProcess;
  }

  async probeCapabilities(request: ProviderProbeRequest = { mode: 'static' }): Promise<ProviderCapabilities> {
    try {
      const { version, models } = await this.staticMetadata();
      if (request.mode === 'static') return baseCapabilities(version, models, false);
      await this.verifyConformance(request);
      return baseCapabilities(version, models, true);
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
    active.cancelRequested = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(resolve, INTERRUPT_TIMEOUT_MS, 'timeout');
      timer.unref();
    });
    const interrupt = active.client.request<Record<string, unknown>>('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    }).then(
      () => active.terminal.then(() => 'terminal' as const),
      () => 'interrupt_failed' as const,
    );

    const outcome = await Promise.race([
      active.terminal.then(() => 'terminal' as const),
      interrupt,
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome !== 'terminal' && this.activeRuns.get(runId) === active) {
      await this.invalidateClient(active.client);
    }
  }

  async dispose(): Promise<void> {
    const state = this.state;
    this.state = null;
    if (state) await disposeQuietly(state.process);
  }

  private async *stream(
    request: ProviderRequest,
    resumeThreadId: string | null,
  ): AsyncGenerator<ProviderEvent> {
    if (request.signal.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    let client: CodexJsonRpcClient | null = null;
    let nativeStateAdvanced = false;
    let active: ActiveRun | null = null;
    let notifications: AsyncIterableIterator<CodexNotification> | null = null;
    let cleaned = false;
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
      void this.cancel(request.runId);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      request.signal.removeEventListener('abort', onAbort);
      if (active && this.activeRuns.get(request.runId) === active) {
        this.activeRuns.delete(request.runId);
        active.resolveTerminal();
      }
    };

    try {
      const state = await this.ensureAppServer();
      client = state.client;
      const thread = resumeThreadId === null
        ? parseThreadResult(await client.request<CodexThreadResult>('thread/start', this.threadStartParams(request)))
        : parseThreadResult(await client.request<CodexThreadResult>('thread/resume', this.threadResumeParams(
            request,
            resumeThreadId,
          )));
      const threadId = thread.thread.id;
      nativeStateAdvanced = true;
      yield { type: 'session_started', nativeSessionId: threadId };

      notifications = client.subscribeNotifications();
      const turn = parseTurnResult(await client.request<CodexTurnResult>('turn/start', {
        threadId,
        input: [
          { type: 'text', text: renderProviderInput(request.input), text_elements: [] },
          ...(request.images ?? []).map((image) => ({
            type: 'localImage',
            path: image.path,
            detail: image.detail,
          })),
        ],
        model: request.model,
        effort: request.effort,
        environments: [],
        outputSchema: request.outputSchema,
      }));
      const runDeferred = deferred();
      active = {
        client,
        threadId,
        turnId: turn.turn.id,
        terminal: runDeferred.terminal,
        resolveTerminal: runDeferred.resolveTerminal,
        cancelRequested: cancellationRequested || request.signal.aborted,
      };
      this.activeRuns.set(request.runId, active);
      if (active.cancelRequested) void this.cancel(request.runId);

      for await (const notification of notifications) {
        if (notification.method === 'item/started' || notification.method === 'item/completed') {
          if (!SAFE_ITEM_TYPES.has(notification.params.item.type)) {
            throw new CodexAdapterError('adapter_protocol_error');
          }
          continue;
        }
        if (notification.method === 'error') {
          throw new CodexAdapterError('adapter_protocol_error');
        }
        if (!this.matches(notification, threadId, turn.turn.id)) continue;
        if (notification.method === 'item/agentMessage/delta') {
          yield request.outputSchema === null
            ? { type: 'text_delta', delta: notification.params.delta }
            : { type: 'structured_delta', delta: notification.params.delta };
          continue;
        }

        cleanup();
        if (notification.params.turn.status === 'completed') {
          yield { type: 'completed' };
        } else if (notification.params.turn.status === 'interrupted') {
          yield { type: 'cancelled' };
        } else {
          yield {
            type: 'failed',
            code: 'adapter_provider_failed',
            message: 'provider turn failed',
            nativeStateAdvanced: true,
          };
        }
        return;
      }
    } catch (error) {
      cleanup();
      if (client) await this.invalidateClient(client);
      if (cancellationRequested || active?.cancelRequested) {
        yield { type: 'cancelled' };
      } else {
        yield failureEvent(error, nativeStateAdvanced);
      }
    } finally {
      await notifications?.return?.();
      cleanup();
    }
  }

  private threadStartParams(request: ProviderRequest): Record<string, unknown> {
    return {
      model: request.model,
      cwd: request.workspace,
      runtimeWorkspaceRoots: [request.workspace],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: API_PROVIDER_SYSTEM_INSTRUCTION,
      developerInstructions: null,
      ephemeral: request.sessionMode === 'ephemeral',
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    };
  }

  private threadResumeParams(request: ProviderRequest, threadId: string): Record<string, unknown> {
    return {
      threadId,
      model: request.model,
      cwd: request.workspace,
      runtimeWorkspaceRoots: [request.workspace],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions: API_PROVIDER_SYSTEM_INSTRUCTION,
      developerInstructions: null,
      excludeTurns: true,
    };
  }

  private matches(notification: CodexNotification, threadId: string, turnId: string): boolean {
    if (notification.method === 'error') return false;
    if (notification.method === 'turn/completed') {
      return notification.params.threadId === threadId && notification.params.turn.id === turnId;
    }
    return notification.params.threadId === threadId && notification.params.turnId === turnId;
  }

  private async ensureAppServer(): Promise<AppServerState> {
    if (this.state && !this.state.client.closed) return this.state;
    if (this.starting) return this.starting;
    this.starting = this.startAppServer();
    try {
      const state = await this.starting;
      this.state = state;
      return state;
    } finally {
      this.starting = null;
    }
  }

  private async startAppServer(): Promise<AppServerState> {
    const managed = this.spawnProcess({
      command: 'codex',
      args: ['app-server', '--stdio'],
      cwd: this.launchCwd,
      env: { ...process.env },
    });
    const client = new CodexJsonRpcClient(managed);
    try {
      await client.request<Record<string, unknown>>('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [...CODEX_IGNORED_NOTIFICATION_METHODS],
        },
      });
      client.notify('initialized');
      return { process: managed, client };
    } catch (error) {
      await disposeQuietly(managed);
      throw error;
    }
  }

  private async invalidateClient(client: CodexJsonRpcClient): Promise<void> {
    const state = this.state;
    if (!state || state.client !== client) return;
    this.state = null;
    await disposeQuietly(state.process);
  }

  private async staticMetadata(): Promise<{ version: string; models: CodexModelListResult }> {
    const versionOutput = await this.runCommand(['--version']);
    await this.runCommand(['app-server', '--help']);
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new CodexAdapterError('adapter_protocol_error');
    const state = await this.ensureAppServer();
    const models = parseModelListResult(
      await state.client.request<CodexModelListResult>('model/list', {}),
    );
    return { version, models };
  }

  private async runCommand(args: string[]): Promise<string> {
    const managed = this.spawnProcess({
      command: 'codex',
      args,
      cwd: this.launchCwd,
      env: { ...process.env },
    });
    try {
      const [exit, stdout, stderr] = await Promise.all([
        managed.exited,
        collectCommandOutput(managed.stdout),
        collectCommandOutput(managed.stderr),
      ]);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (exit.code !== 0 || output.trim().length === 0) {
        throw new CodexAdapterError('adapter_process_error');
      }
      return output;
    } finally {
      await disposeQuietly(managed);
    }
  }

  private async verifyConformance(request: Extract<ProviderProbeRequest, { mode: 'conformance' }>): Promise<void> {
    const baseRequest: ProviderRequest = {
      runId: `conformance-start-${Date.now()}`,
      targetId: request.targetId,
      model: request.model,
      effort: request.effort,
      workspace: request.workspace,
      input: [{ role: 'user', content: 'Return a short confirmation.' }],
      sessionMode: 'persistent',
      runTimeoutMs: null,
      outputSchema: CONFORMANCE_SCHEMA,
      signal: request.signal,
    };
    const first = await this.requireConformanceEvents(this.start(baseRequest));
    await this.requireConformanceEvents(this.resume({
      ...baseRequest,
      runId: `conformance-resume-${Date.now()}`,
      nativeSessionId: first,
    }));
  }

  private async requireConformanceEvents(events: AsyncIterable<ProviderEvent>): Promise<string> {
    let threadId: string | null = null;
    let completed = false;
    let structuredOutput = '';
    for await (const event of events) {
      if (event.type === 'session_started') threadId = event.nativeSessionId;
      else if (event.type === 'structured_delta') structuredOutput += event.delta;
      else if (event.type === 'completed') completed = true;
      else throw new CodexAdapterError('adapter_protocol_error');
    }
    if (!threadId || !completed) throw new CodexAdapterError('adapter_protocol_error');
    let parsed: unknown;
    try {
      parsed = JSON.parse(structuredOutput);
    } catch {
      throw new CodexAdapterError('adapter_protocol_error');
    }
    if (!validateConformanceOutput(parsed)) throw new CodexAdapterError('adapter_protocol_error');
    return threadId;
  }
}
