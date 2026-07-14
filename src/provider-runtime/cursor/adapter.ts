import { z } from 'zod';
import { renderProviderInput } from '../provider-input.js';
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
import {
  CursorAdapterError,
  cursorAssistantText,
  parseCursorEvent,
} from './protocol.js';

const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const REQUIRED_HELP_FLAGS = [
  '--print',
  '--output-format',
  '--stream-partial-output',
  '--mode',
  '--resume',
  '--model',
  '--list-models',
  '--sandbox',
  '--trust',
];
const CONFORMANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string', minLength: 1 },
  },
  required: ['type', 'content'],
};
const conformanceOutputSchema = z.object({
  type: z.literal('assistant_text'),
  content: z.string().min(1),
}).strict();

export const CURSOR_SANDBOX_WARNING = 'Cursor Agent runs in Ask mode with its sandbox enabled, but the CLI has no no-tools flag; Gateway rejects every native tool event.';
export const CURSOR_SESSION_WARNING = 'Cursor Agent has no no-session-persistence flag, so provider-native chat state may outlive an ephemeral Gateway request.';
export const CURSOR_TOOL_BRIDGE_WARNING = 'Cursor client tools use a Gateway JSON protocol because cursor-agent has no native output-schema flag; malformed model output is rejected.';

export interface CursorProviderAdapterOptions {
  spawnProcess?: SpawnManagedProcess;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

interface StaticMetadata {
  version: string;
  models: ProviderModelOption[];
}

interface ActiveRun {
  process: ManagedProcess;
  cancellationRequested: boolean;
}

interface StreamObservation {
  sawPartialOutput: boolean;
}

function capabilities(
  metadata: StaticMetadata,
  verified: boolean,
  streamingMode: ProviderCapabilities['streamingMode'] = 'native',
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
    streamingMode,
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    details: [CURSOR_SANDBOX_WARNING, CURSOR_SESSION_WARNING, CURSOR_TOOL_BRIDGE_WARNING],
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
  if (error instanceof CursorAdapterError) return error.code;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error'
    ? String(error.code)
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
      ? 'Cursor provider protocol error'
      : 'Cursor provider process error',
    nativeStateAdvanced,
  };
}

async function disposeQuietly(managed: ManagedProcess): Promise<void> {
  try {
    await managed.dispose();
  } catch {
    // The print process may exit while process-group cleanup is in progress.
  }
}

function writeInput(managed: ManagedProcess, input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = () => reject(Object.assign(new Error('adapter_process_error'), {
      code: 'adapter_process_error',
    }));
    managed.stdin.once('error', onError);
    managed.stdin.end(input, () => {
      managed.stdin.removeListener('error', onError);
      resolve();
    });
  });
}

export function parseCursorModels(output: string): ProviderModelOption[] {
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.replace(ANSI_ESCAPE, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || /^available models$/i.test(line) || /^tip:/i.test(line)) continue;
    const separator = line.indexOf(' - ');
    if (separator <= 0) continue;
    const id = line.slice(0, separator).trim();
    const label = line.slice(separator + 3).trim();
    if (!/^\S+$/.test(id) || label.length === 0 || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label, effortOptions: null });
  }
  if (models.length === 0) throw new CursorAdapterError('adapter_protocol_error');
  return models;
}

export function renderCursorPrompt(
  request: Pick<ProviderRequest, 'input' | 'outputSchema'>,
): string {
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
    sections.push('Return only the assistant response. Do not use native tools or add protocol markup.');
  }
  return sections.join('\n\n');
}

export class CursorProviderAdapter implements ProviderAdapter {
  private readonly spawnProcess: SpawnManagedProcess;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly launchCwd = process.cwd();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: CursorProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnManagedProcess;
    this.command = options.command ?? 'cursor-agent';
    this.env = options.env ?? { ...process.env };
  }

  async probeCapabilities(
    request: ProviderProbeRequest = { mode: 'static' },
  ): Promise<ProviderCapabilities> {
    try {
      const metadata = await this.staticMetadata();
      if (request.mode === 'static') return capabilities(metadata, false);
      const streaming = await this.verifyConformance(request);
      return capabilities(metadata, true, streaming ? 'native' : 'none');
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
    await active.process.interrupt();
  }

  private args(request: ProviderRequest, nativeSessionId: string | null): string[] {
    return [
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--mode', 'ask',
      '--sandbox', 'enabled',
      '--trust',
      '--model', request.model,
      ...(nativeSessionId ? ['--resume', nativeSessionId] : []),
    ];
  }

  private async *stream(
    request: ProviderRequest,
    nativeSessionId: string | null,
    observation?: StreamObservation,
  ): AsyncGenerator<ProviderEvent> {
    if (request.signal.aborted) {
      yield { type: 'cancelled' };
      return;
    }

    let managed: ManagedProcess | null = null;
    let active: ActiveRun | null = null;
    let sessionId: string | null = null;
    let aggregateText: string | null = null;
    let partialText = '';
    let sawPartialOutput = false;
    let nativeStateAdvanced = false;
    let terminal = false;
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
      void this.cancel(request.runId).catch(() => undefined);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const input = renderCursorPrompt(request);
      managed = this.spawnProcess({
        command: this.command,
        args: this.args(request, nativeSessionId),
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

      await writeInput(managed, input);
      nativeStateAdvanced = true;
      for await (const line of readBoundedLines(managed.stdout)) {
        const event = parseCursorEvent(line);
        if (event.type === 'system') {
          if (sessionId !== null || (nativeSessionId !== null && event.session_id !== nativeSessionId)) {
            throw new CursorAdapterError('adapter_protocol_error');
          }
          sessionId = event.session_id;
          yield { type: 'session_started', nativeSessionId: sessionId };
          continue;
        }

        if (sessionId === null || event.session_id !== sessionId) {
          throw new CursorAdapterError('adapter_protocol_error');
        }
        if (event.type === 'user' || event.type === 'thinking') continue;
        if (event.type === 'tool_call') throw new CursorAdapterError('adapter_protocol_error');

        if (event.type === 'assistant') {
          const text = cursorAssistantText(event);
          if (event.timestamp_ms !== undefined) {
            sawPartialOutput = true;
            partialText += text;
            if (observation) observation.sawPartialOutput = true;
            yield request.outputSchema === null
              ? { type: 'text_delta', delta: text }
              : { type: 'structured_delta', delta: text };
          } else {
            if (aggregateText !== null) throw new CursorAdapterError('adapter_protocol_error');
            aggregateText = text;
          }
          continue;
        }

        terminal = true;
        if (event.is_error || event.subtype !== 'success') {
          yield {
            type: 'failed',
            code: 'adapter_provider_failed',
            message: 'Cursor provider turn failed',
            nativeStateAdvanced: true,
          };
          return;
        }
        const finalText = event.result ?? aggregateText;
        if (finalText === null || finalText.length === 0
          || (aggregateText !== null && aggregateText !== finalText)
          || (sawPartialOutput && partialText !== finalText)) {
          throw new CursorAdapterError('adapter_protocol_error');
        }
        if (!sawPartialOutput) {
          yield request.outputSchema === null
            ? { type: 'text_delta', delta: finalText }
            : { type: 'structured_delta', delta: finalText };
        }
        yield { type: 'completed' };
        return;
      }

      const exit = await managed.exited;
      if (!terminal) {
        if (cancellationRequested || active?.cancellationRequested) {
          yield { type: 'cancelled' };
        } else if (exit.code !== 0) {
          throw Object.assign(new Error('adapter_process_error'), { code: 'adapter_process_error' });
        } else {
          throw new CursorAdapterError('adapter_protocol_error');
        }
      }
    } catch (error) {
      if (cancellationRequested || active?.cancellationRequested) {
        yield { type: 'cancelled' };
      } else {
        yield failureEvent(error, nativeStateAdvanced);
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
      throw new CursorAdapterError('adapter_capability_unsupported');
    }
    const modelsOutput = await this.runCommand(['--list-models']);
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new CursorAdapterError('adapter_protocol_error');
    return { version, models: parseCursorModels(modelsOutput) };
  }

  private async runCommand(args: string[]): Promise<string> {
    const managed = this.spawnProcess({
      command: this.command,
      args,
      cwd: this.launchCwd,
      env: { ...this.env },
    });
    managed.stdin.end();
    try {
      let output = '';
      const collect = (async () => {
        for await (const line of readBoundedLines(managed.stdout)) {
          output += `${line}\n`;
          if (Buffer.byteLength(output) > COMMAND_OUTPUT_LIMIT_BYTES) {
            throw new CursorAdapterError('adapter_protocol_error');
          }
        }
      })();
      const [exit] = await Promise.all([managed.exited, collect]);
      if (exit.code !== 0 || output.trim().length === 0) {
        throw Object.assign(new Error('adapter_process_error'), { code: 'adapter_process_error' });
      }
      return output.trim();
    } finally {
      await disposeQuietly(managed);
    }
  }

  private async verifyConformance(
    request: Extract<ProviderProbeRequest, { mode: 'conformance' }>,
  ): Promise<boolean> {
    const baseRequest: ProviderRequest = {
      runId: `cursor-conformance-start-${Date.now()}`,
      targetId: request.targetId,
      model: request.model,
      effort: null,
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
    const firstObservation: StreamObservation = { sawPartialOutput: false };
    const nativeSessionId = await this.requireConformanceEvents(
      this.stream(baseRequest, null, firstObservation),
    );
    const resumeObservation: StreamObservation = { sawPartialOutput: false };
    await this.requireConformanceEvents(this.stream({
      ...baseRequest,
      runId: `cursor-conformance-resume-${Date.now()}`,
      input: [{
        role: 'user',
        content: 'Return another assistant_text JSON object with a short English confirmation.',
      }],
    }, nativeSessionId, resumeObservation));
    return firstObservation.sawPartialOutput && resumeObservation.sawPartialOutput;
  }

  private async requireConformanceEvents(events: AsyncIterable<ProviderEvent>): Promise<string> {
    let nativeSessionId: string | null = null;
    let structuredOutput = '';
    let completed = false;
    for await (const event of events) {
      if (event.type === 'session_started') nativeSessionId = event.nativeSessionId;
      else if (event.type === 'structured_delta') structuredOutput += event.delta;
      else if (event.type === 'completed') completed = true;
      else throw new CursorAdapterError('adapter_protocol_error');
    }
    if (!nativeSessionId || !completed) throw new CursorAdapterError('adapter_protocol_error');
    let parsed: unknown;
    try {
      parsed = JSON.parse(structuredOutput);
    } catch {
      throw new CursorAdapterError('adapter_protocol_error');
    }
    if (!conformanceOutputSchema.safeParse(parsed).success) {
      throw new CursorAdapterError('adapter_protocol_error');
    }
    return nativeSessionId;
  }
}
