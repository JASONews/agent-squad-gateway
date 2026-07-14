import { homedir } from 'node:os';
import { renderProviderInput } from '../provider-input.js';
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
import {
  formatAgyTimeout,
  getAntigravityConversationId,
} from './conversation.js';

const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const TURN_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const REQUIRED_HELP_FLAGS = [
  '--sandbox',
  '--model',
  '--print-timeout',
  '--conversation',
  '--print',
];
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export const ANTIGRAVITY_ARGV_WARNING = 'Because Antigravity 1.1.1 has no verified stdin prompt contract, prompt content is temporarily visible in local process argv.';
export const ANTIGRAVITY_TOOL_BRIDGE_WARNING = 'Antigravity client tools use a Gateway JSON protocol because agy has no native output-schema flag; malformed model output is rejected.';

const CONFORMANCE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string', minLength: 1 },
  },
  required: ['type', 'content'],
};

export interface AntigravityProviderAdapterOptions {
  spawnProcess?: SpawnManagedProcess;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
}

interface ActiveRun {
  process: ManagedProcess;
  cancellationRequested: boolean;
}

interface StaticMetadata {
  version: string;
  models: ProviderModelOption[];
}

class AntigravityAdapterError extends Error {
  constructor(readonly code: 'adapter_protocol_error' | 'adapter_capability_unsupported') {
    super(code);
    this.name = 'AntigravityAdapterError';
  }
}

function capabilities(
  metadata: StaticMetadata,
  verified: boolean,
): ProviderCapabilities {
  return {
    available: true,
    version: metadata.version,
    verified,
    ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
    modelSelection: true,
    effortSelection: false,
    modelOptions: metadata.models.map((model) => ({ ...model, effortOptions: null })),
    isolationLevel: 'best_effort',
    streamingMode: 'none',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    details: [ANTIGRAVITY_ARGV_WARNING, ANTIGRAVITY_TOOL_BRIDGE_WARNING],
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

function errorCode(error: unknown): string | null {
  if (error instanceof AntigravityAdapterError) return error.code;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = error.code;
  return code === 'adapter_spawn_failed' || code === 'adapter_process_error'
    ? code
    : null;
}

function safeProbeError(error: unknown): string {
  return errorCode(error) ?? 'capability_probe_failed';
}

function failureEvent(error: unknown, nativeStateAdvanced: boolean): ProviderEvent {
  const knownCode = errorCode(error);
  const code = knownCode === 'adapter_spawn_failed' || knownCode === 'adapter_process_error'
    ? knownCode
    : 'adapter_protocol_error';
  return {
    type: 'failed',
    code,
    message: code === 'adapter_protocol_error'
      ? 'Antigravity provider protocol error'
      : 'Antigravity provider process error',
    nativeStateAdvanced,
  };
}

async function disposeQuietly(managed: ManagedProcess): Promise<void> {
  try {
    await managed.dispose();
  } catch {
    // The child may exit while process-group cleanup is in progress.
  }
}

async function readBoundedOutput(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > limitBytes) throw new AntigravityAdapterError('adapter_protocol_error');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function boundedOutputCollector(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
): { value(): string; stop(): void } {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  const onData = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += chunk.length;
    if (size > limitBytes) overflow = true;
    else chunks.push(chunk);
  };
  stream.on('data', onData);
  return {
    value() {
      if (overflow) throw new AntigravityAdapterError('adapter_protocol_error');
      return Buffer.concat(chunks, size).toString('utf8');
    },
    stop() { stream.removeListener('data', onData); },
  };
}

function parseModels(output: string): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '');
    if (line.length === 0 || /^(?:available\s+)?models?:?$/i.test(line) || seen.has(line)) continue;
    seen.add(line);
    models.push({ id: line, label: line, effortOptions: null });
  }
  if (models.length === 0) throw new AntigravityAdapterError('adapter_protocol_error');
  return models;
}

export function renderAntigravityPrompt(request: Pick<ProviderRequest, 'input' | 'outputSchema'>): string {
  const transcript = renderProviderInput(request.input);
  const sections = [
    [
      'Complete the API conversation below as a single assistant turn.',
      'Answer only from the supplied conversation and do not use tools, shell commands, files, browsers,',
      'external integrations, skills, plugins, hooks, or agents during this turn.',
    ].join(' '),
    `API conversation:\n${transcript}`,
  ];
  if (request.outputSchema !== null) {
    sections.push(
      `Required response schema:\n${JSON.stringify(request.outputSchema)}`,
      [
        'Client functions are descriptions only; represent a client function call through the response schema',
        'and do not execute it or use native tools.',
        'Return exactly one raw JSON object that validates against the required response schema.',
        'Do not add Markdown fences, commentary, reasoning, or any text before or after that JSON object.',
      ].join(' '),
    );
  } else {
    sections.push(
      'Return only the assistant response. Do not use native tools or add protocol markup.',
    );
  }
  return sections.join('\n\n');
}

export class AntigravityProviderAdapter implements ProviderAdapter {
  private readonly spawnProcess: SpawnManagedProcess;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly launchCwd = process.cwd();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: AntigravityProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnManagedProcess;
    this.env = options.env ?? { ...process.env };
    this.homeDir = options.homeDir ?? this.env.HOME ?? homedir();
    this.command = options.command ?? 'agy';
  }

  async probeCapabilities(
    request: ProviderProbeRequest = { mode: 'static' },
  ): Promise<ProviderCapabilities> {
    try {
      const metadata = await this.staticMetadata();
      if (request.mode === 'static') return capabilities(metadata, false);
      await this.verifyConformance(request);
      return capabilities(metadata, true);
    } catch (error) {
      return unavailable(safeProbeError(error));
    }
  }

  start(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    return this.run(request, null);
  }

  resume(request: ProviderResumeRequest): AsyncIterable<ProviderEvent> {
    return this.run(request, request.nativeSessionId);
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.cancellationRequested = true;
    await active.process.interrupt();
  }

  private args(
    request: ProviderRequest,
    nativeSessionId: string | null,
    prompt: string,
  ): string[] {
    return [
      '--sandbox',
      '--model',
      request.model,
      '--print-timeout',
      formatAgyTimeout(request.runTimeoutMs),
      ...(nativeSessionId ? ['--conversation', nativeSessionId] : []),
      '--print',
      prompt,
    ];
  }

  private async *run(
    request: ProviderRequest,
    nativeSessionId: string | null,
  ): AsyncGenerator<ProviderEvent> {
    if (request.signal.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    let managed: ManagedProcess | null = null;
    let active: ActiveRun | null = null;
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
      void this.cancel(request.runId).catch(() => undefined);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const prompt = renderAntigravityPrompt(request);
      const priorConversationId = nativeSessionId === null
        ? getAntigravityConversationId(this.homeDir, request.workspace)
        : null;
      managed = this.spawnProcess({
        command: this.command,
        args: this.args(request, nativeSessionId, prompt),
        cwd: request.workspace,
        env: { ...this.env },
      });
      active = { process: managed, cancellationRequested: false };
      this.activeRuns.set(request.runId, active);
      if (request.signal.aborted) {
        cancellationRequested = true;
        active.cancellationRequested = true;
        await managed.interrupt();
      }

      const outputPromise = readBoundedOutput(managed.stdout, TURN_OUTPUT_LIMIT_BYTES);
      const [exit, rawOutput] = await Promise.all([managed.exited, outputPromise]);
      if (cancellationRequested || active.cancellationRequested) {
        yield { type: 'cancelled' };
        return;
      }
      if (exit.code !== 0) {
        throw Object.assign(new Error('adapter_process_error'), { code: 'adapter_process_error' });
      }

      const sessionId = nativeSessionId
        ?? getAntigravityConversationId(this.homeDir, request.workspace);
      const output = rawOutput.trim();
      if (!sessionId
        || (nativeSessionId === null && sessionId === priorConversationId)
        || output.length === 0) {
        throw new AntigravityAdapterError('adapter_protocol_error');
      }
      yield { type: 'session_started', nativeSessionId: sessionId };
      yield request.outputSchema === null
        ? { type: 'text_delta', delta: output }
        : { type: 'structured_delta', delta: output };
      yield { type: 'completed' };
    } catch (error) {
      if (cancellationRequested || active?.cancellationRequested) {
        yield { type: 'cancelled' };
      } else {
        const spawnFailed = errorCode(error) === 'adapter_spawn_failed';
        yield failureEvent(error, managed !== null && !spawnFailed);
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (active && this.activeRuns.get(request.runId) === active) {
        this.activeRuns.delete(request.runId);
      }
      if (managed) await disposeQuietly(managed);
    }
  }

  private async staticMetadata(): Promise<StaticMetadata> {
    const versionOutput = await this.runCommand(['--version']);
    const helpOutput = await this.runCommand(['--help']);
    if (REQUIRED_HELP_FLAGS.some((flag) => !helpOutput.includes(flag))) {
      throw new AntigravityAdapterError('adapter_capability_unsupported');
    }
    const modelsOutput = await this.runCommand(['models']);
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new AntigravityAdapterError('adapter_protocol_error');
    return { version, models: parseModels(modelsOutput) };
  }

  private async runCommand(args: string[]): Promise<string> {
    const managed = this.spawnProcess({
      command: this.command,
      args,
      cwd: this.launchCwd,
      env: { ...this.env },
    });
    const stdout = boundedOutputCollector(managed.stdout, COMMAND_OUTPUT_LIMIT_BYTES);
    const stderr = boundedOutputCollector(managed.stderr, COMMAND_OUTPUT_LIMIT_BYTES);
    managed.stdin.end();
    try {
      const exit = await managed.exited;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (exit.code !== 0) {
        throw Object.assign(new Error('adapter_process_error'), { code: 'adapter_process_error' });
      }
      const output = [stdout.value().trim(), stderr.value().trim()].filter(Boolean).join('\n');
      if (output.trim().length === 0) {
        throw new AntigravityAdapterError('adapter_protocol_error');
      }
      return output;
    } finally {
      stdout.stop();
      stderr.stop();
      await disposeQuietly(managed);
    }
  }

  private async verifyConformance(
    request: Extract<ProviderProbeRequest, { mode: 'conformance' }>,
  ): Promise<void> {
    const baseRequest: ProviderRequest = {
      runId: `antigravity-conformance-start-${Date.now()}`,
      targetId: request.targetId,
      model: request.model,
      effort: null,
      workspace: request.workspace,
      input: [{
        role: 'user',
        content: 'Return an assistant_text JSON object with a short English confirmation.',
      }],
      sessionMode: 'persistent',
      runTimeoutMs: 60_000,
      outputSchema: CONFORMANCE_OUTPUT_SCHEMA,
      signal: request.signal,
    };
    const nativeSessionId = await this.requireStructuredConformance(this.start(baseRequest));
    await this.requireStructuredConformance(this.resume({
      ...baseRequest,
      runId: `antigravity-conformance-resume-${Date.now()}`,
      input: [{
        role: 'user',
        content: 'Return another assistant_text JSON object with a short English confirmation.',
      }],
      nativeSessionId,
    }));
  }

  private async requireStructuredConformance(events: AsyncIterable<ProviderEvent>): Promise<string> {
    let nativeSessionId: string | null = null;
    let output = '';
    let completed = false;
    for await (const event of events) {
      if (event.type === 'session_started') nativeSessionId = event.nativeSessionId;
      else if (event.type === 'structured_delta') output += event.delta;
      else if (event.type === 'completed') completed = true;
      else throw new AntigravityAdapterError('adapter_protocol_error');
    }
    if (!nativeSessionId || output.trim().length === 0 || !completed) {
      throw new AntigravityAdapterError('adapter_protocol_error');
    }
    try {
      const parsed: unknown = JSON.parse(output);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new AntigravityAdapterError('adapter_protocol_error');
      }
      const record = parsed as Record<string, unknown>;
      if (record.type !== 'assistant_text'
        || typeof record.content !== 'string'
        || record.content.length === 0
        || Object.keys(record).length !== 2) {
        throw new AntigravityAdapterError('adapter_protocol_error');
      }
    } catch (error) {
      if (error instanceof AntigravityAdapterError) throw error;
      throw new AntigravityAdapterError('adapter_protocol_error');
    }
    return nativeSessionId;
  }
}
