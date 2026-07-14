import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const DEFAULT_INTERRUPT_GRACE_MS = 2_000;
const STDERR_DIAGNOSTIC_BYTES = 8 * 1024;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface ManagedProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ManagedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  interrupt(graceMs?: number): Promise<void>;
  dispose(): Promise<void>;
  stderrDiagnostic(): string;
}

export type SpawnManagedProcess = (spec: ManagedProcessSpec) => ManagedProcess;

class ManagedProcessError extends Error {
  constructor(readonly code: 'adapter_spawn_failed' | 'adapter_process_error') {
    super(code);
    this.name = 'ManagedProcessError';
  }
}

class StderrDiagnosticRing {
  private retained: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  append(value: Buffer | string): void {
    const sanitized = String(value).replace(ANSI_ESCAPE, '').replace(UNSAFE_CONTROL, '');
    const next = Buffer.concat([this.retained, Buffer.from(sanitized)]);
    this.retained = next.length <= STDERR_DIAGNOSTIC_BYTES
      ? next
      : validUtf8Tail(next.subarray(next.length - STDERR_DIAGNOSTIC_BYTES));
  }

  value(): string {
    return this.retained.toString('utf8');
  }
}

function validUtf8Tail(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
}

function validGraceMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (process.platform === 'win32' || child.pid === undefined) return child.kill(signal);
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw new ManagedProcessError('adapter_process_error');
  }
}

export const spawnManagedProcess: SpawnManagedProcess = (spec) => {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  });
  const diagnostic = new StderrDiagnosticRing();
  child.stderr.on('data', (chunk: Buffer | string) => diagnostic.append(chunk));

  let settled = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => {
      settled = true;
      reject(new ManagedProcessError('adapter_spawn_failed'));
    });
    child.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  void exited.catch(() => undefined);

  async function waitForExit(graceMs: number): Promise<boolean> {
    if (settled) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(resolve, graceMs, false);
      void exited.then(
        () => { clearTimeout(timer); resolve(true); },
        () => { clearTimeout(timer); resolve(true); },
      );
    });
  }

  async function interrupt(graceMs = DEFAULT_INTERRUPT_GRACE_MS): Promise<void> {
    if (!validGraceMs(graceMs)) throw new ManagedProcessError('adapter_process_error');
    if (settled || !signalProcessGroup(child, 'SIGINT')) return;
    if (await waitForExit(graceMs)) return;
    if (!signalProcessGroup(child, 'SIGTERM')) return;
    if (await waitForExit(graceMs)) return;
    if (!signalProcessGroup(child, 'SIGKILL')) return;
    await waitForExit(graceMs);
  }

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid ?? -1,
    exited,
    interrupt,
    async dispose(): Promise<void> {
      if (!child.stdin.destroyed) child.stdin.end();
      await interrupt();
      child.stdout.destroy();
      child.stderr.destroy();
    },
    stderrDiagnostic: () => diagnostic.value(),
  };
};
