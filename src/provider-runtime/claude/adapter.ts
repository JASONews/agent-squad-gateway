import { z } from 'zod';
import { readFile } from 'node:fs/promises';
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
  ProviderProbeRequest,
  ProviderRequest,
  ProviderResumeRequest,
} from '../types.js';
import {
  ClaudeAdapterError,
  hasStrictIsolationEvidence,
  parseClaudeEvent,
} from './protocol.js';

const COMMAND_OUTPUT_LIMIT_BYTES = 64 * 1024;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'];
const REQUIRED_HELP_FLAGS = [
  '--print', '--safe-mode', '--disable-slash-commands', '--strict-mcp-config',
  '--mcp-config', '--tools', '--permission-mode', '--no-chrome', '--system-prompt',
  '--model', '--effort', '--output-format', '--include-partial-messages', '--verbose',
  '--input-format', '--no-session-persistence', '--resume', '--json-schema',
];
const CONFORMANCE_SCHEMA = {
  type: 'object',
  required: ['type', 'content'],
  properties: {
    type: { const: 'assistant_text' },
    content: { type: 'string' },
  },
  additionalProperties: false,
};
const conformanceOutputSchema = z.object({
  type: z.literal('assistant_text'),
  content: z.string(),
}).strict();

interface ClaudeProviderAdapterOptions {
  spawnProcess?: SpawnManagedProcess;
}

interface StreamObservation {
  strictIsolation: boolean;
  sawStructuredStream: boolean;
}

interface ConformanceResult {
  strictIsolation: boolean;
  schemaStream: boolean;
}

interface ActiveRun {
  process: ManagedProcess;
  cancellationRequested: boolean;
}

function capabilities(
  version: string,
  verified: boolean,
  isolationLevel: ProviderCapabilities['isolationLevel'],
  toolBridge: ProviderCapabilities['toolBridge'],
): ProviderCapabilities {
  return {
    available: true,
    version,
    verified,
    ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
    modelSelection: true,
    effortSelection: true,
    modelOptions: [{
      id: 'default',
      label: 'Claude Code default',
      effortOptions: [...EFFORT_OPTIONS],
    }],
    isolationLevel,
    streamingMode: 'native',
    toolBridge,
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

function safeErrorCode(error: unknown): string {
  if (error instanceof ClaudeAdapterError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'adapter_spawn_failed' || error.code === 'adapter_process_error')) {
    return String(error.code);
  }
  return 'capability_probe_failed';
}

function failureEvent(error: unknown, nativeStateAdvanced: boolean): ProviderEvent {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'adapter_process_error'
    ? 'adapter_process_error'
    : 'adapter_protocol_error';
  return {
    type: 'failed',
    code,
    message: code === 'adapter_process_error'
      ? 'Claude provider process error'
      : 'Claude provider protocol error',
    nativeStateAdvanced,
  };
}

async function disposeQuietly(process: ManagedProcess): Promise<void> {
  try {
    await process.dispose();
  } catch {
    // The print process may exit while process-group cleanup is in progress.
  }
}

function writeInput(process: ManagedProcess, input: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = () => reject(Object.assign(new Error('adapter_process_error'), {
      code: 'adapter_process_error',
    }));
    process.stdin.once('error', onError);
    process.stdin.end(input, () => {
      process.stdin.removeListener('error', onError);
      resolve();
    });
  });
}

export class ClaudeProviderAdapter implements ProviderAdapter {
  private readonly spawnProcess: SpawnManagedProcess;
  private readonly launchCwd = process.cwd();
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(options: ClaudeProviderAdapterOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawnManagedProcess;
  }

  async probeCapabilities(request: ProviderProbeRequest = { mode: 'static' }): Promise<ProviderCapabilities> {
    try {
      const version = await this.staticMetadata();
      if (request.mode === 'static') {
        return capabilities(version, false, 'best_effort', 'structured_output');
      }
      const conformance = await this.verifyConformance(request);
      return capabilities(
        version,
        true,
        conformance.strictIsolation ? 'strict' : 'best_effort',
        conformance.schemaStream ? 'structured_output' : 'none',
      );
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
    active.cancellationRequested = true;
    await active.process.interrupt();
  }

  private args(request: ProviderRequest, nativeSessionId: string | null): string[] {
    return [
      '--print', '--safe-mode', '--disable-slash-commands',
      '--strict-mcp-config', '--mcp-config', EMPTY_MCP_CONFIG,
      '--tools', '', '--permission-mode', 'dontAsk', '--no-chrome',
      '--system-prompt', API_PROVIDER_SYSTEM_INSTRUCTION,
      '--model', request.model,
      ...(request.effort ? ['--effort', request.effort] : []),
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--input-format', (request.images?.length ?? 0) > 0 ? 'stream-json' : 'text',
      ...(request.sessionMode === 'ephemeral' ? ['--no-session-persistence'] : []),
      ...(nativeSessionId ? ['--resume', nativeSessionId] : []),
      ...(request.outputSchema ? ['--json-schema', JSON.stringify(request.outputSchema)] : []),
    ];
  }

  private async input(request: ProviderRequest): Promise<string> {
    const text = renderProviderInput(request.input);
    if ((request.images?.length ?? 0) === 0) return text;
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    for (const image of request.images!) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: (await readFile(image.path)).toString('base64'),
        },
      });
    }
    return `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    })}\n`;
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
    let nativeStateAdvanced = false;
    let terminal = false;
    let sawStructuredStream = false;
    let cancellationRequested = false;
    const onAbort = () => {
      cancellationRequested = true;
      void this.cancel(request.runId);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      const input = await this.input(request);
      managed = this.spawnProcess({
        command: 'claude',
        args: this.args(request, nativeSessionId),
        cwd: request.workspace,
        env: { ...process.env },
      });
      active = { process: managed, cancellationRequested: false };
      this.activeRuns.set(request.runId, active);
      if (request.signal.aborted) {
        cancellationRequested = true;
        await managed.interrupt();
      }

      await writeInput(managed, input);
      nativeStateAdvanced = true;
      for await (const line of readBoundedLines(managed.stdout)) {
        const event = parseClaudeEvent(line);
        if (event === null) continue;

        if (event.type === 'system') {
          if (sessionId !== null) throw new ClaudeAdapterError('adapter_protocol_error');
          sessionId = event.session_id;
          if (observation) observation.strictIsolation = hasStrictIsolationEvidence(event);
          yield { type: 'session_started', nativeSessionId: sessionId };
          continue;
        }

        if (event.session_id && event.session_id !== sessionId) {
          throw new ClaudeAdapterError('adapter_protocol_error');
        }
        if (sessionId === null) throw new ClaudeAdapterError('adapter_protocol_error');

        if (event.type === 'stream_event') {
          if (request.outputSchema === null) {
            yield { type: 'text_delta', delta: event.event.delta.text };
          } else {
            sawStructuredStream = true;
            if (observation) observation.sawStructuredStream = true;
            yield { type: 'structured_delta', delta: event.event.delta.text };
          }
          continue;
        }
        if (event.type === 'assistant') continue;

        terminal = true;
        if (event.is_error) {
          yield {
            type: 'failed',
            code: 'adapter_provider_failed',
            message: 'Claude provider turn failed',
            nativeStateAdvanced: true,
          };
          return;
        }
        if (request.outputSchema !== null && !sawStructuredStream) {
          if (event.structured_output === undefined) {
            throw new ClaudeAdapterError('adapter_protocol_error');
          }
          const structured = JSON.stringify(event.structured_output);
          if (structured === undefined) throw new ClaudeAdapterError('adapter_protocol_error');
          yield { type: 'structured_delta', delta: structured };
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
          throw new ClaudeAdapterError('adapter_protocol_error');
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

  private async staticMetadata(): Promise<string> {
    const versionOutput = await this.runCommand(['--version']);
    const helpOutput = await this.runCommand(['--help']);
    if (REQUIRED_HELP_FLAGS.some((flag) => !helpOutput.includes(flag))) {
      throw new ClaudeAdapterError('adapter_capability_unsupported');
    }
    const version = versionOutput.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new ClaudeAdapterError('adapter_protocol_error');
    return version;
  }

  private async runCommand(args: string[]): Promise<string> {
    const managed = this.spawnProcess({
      command: 'claude',
      args,
      cwd: this.launchCwd,
      env: { ...process.env },
    });
    try {
      let output = '';
      const collect = (async () => {
        for await (const line of readBoundedLines(managed.stdout)) {
          output += `${line}\n`;
          if (Buffer.byteLength(output) > COMMAND_OUTPUT_LIMIT_BYTES) {
            throw new ClaudeAdapterError('adapter_protocol_error');
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
  ): Promise<ConformanceResult> {
    const baseRequest: ProviderRequest = {
      runId: `claude-conformance-start-${Date.now()}`,
      targetId: request.targetId,
      model: request.model,
      effort: request.effort,
      workspace: request.workspace,
      input: [{
        role: 'user',
        content: 'Return JSON with type "assistant_text" and a short English confirmation in content.',
      }],
      sessionMode: 'persistent',
      runTimeoutMs: null,
      outputSchema: CONFORMANCE_SCHEMA,
      signal: request.signal,
    };
    const firstObservation: StreamObservation = {
      strictIsolation: false,
      sawStructuredStream: false,
    };
    const nativeSessionId = await this.requireConformanceEvents(
      this.stream(baseRequest, null, firstObservation),
    );
    const resumeObservation: StreamObservation = {
      strictIsolation: false,
      sawStructuredStream: false,
    };
    await this.requireConformanceEvents(this.stream({
      ...baseRequest,
      runId: `claude-conformance-resume-${Date.now()}`,
      input: [{
        role: 'user',
        content: 'Return the same schema with a short English confirmation.',
      }],
    }, nativeSessionId, resumeObservation));
    return {
      strictIsolation: firstObservation.strictIsolation && resumeObservation.strictIsolation,
      schemaStream: firstObservation.sawStructuredStream && resumeObservation.sawStructuredStream,
    };
  }

  private async requireConformanceEvents(events: AsyncIterable<ProviderEvent>): Promise<string> {
    let nativeSessionId: string | null = null;
    let structuredOutput = '';
    let completed = false;
    for await (const event of events) {
      if (event.type === 'session_started') nativeSessionId = event.nativeSessionId;
      else if (event.type === 'structured_delta') structuredOutput += event.delta;
      else if (event.type === 'completed') completed = true;
      else throw new ClaudeAdapterError('adapter_protocol_error');
    }
    if (!nativeSessionId || !completed) throw new ClaudeAdapterError('adapter_protocol_error');
    let parsed: unknown;
    try {
      parsed = JSON.parse(structuredOutput);
    } catch {
      throw new ClaudeAdapterError('adapter_protocol_error');
    }
    if (!conformanceOutputSchema.safeParse(parsed).success) {
      throw new ClaudeAdapterError('adapter_protocol_error');
    }
    return nativeSessionId;
  }
}
