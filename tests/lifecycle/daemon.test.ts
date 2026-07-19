import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { openGatewayDb } from '../../src/control-plane/db.js';
import { readPid, writePid } from '../../src/lifecycle/pidfile.js';
import { registerBuiltInProviders } from '../../src/provider-runtime/register-providers.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import type { ProviderAdapter, ProviderCapabilities } from '../../src/provider-runtime/types.js';
import {
  createGatewayRuntime,
  doctorGateway,
  openGateway,
  startGateway,
  statusGateway,
  stopGateway,
  type GatewayRuntime,
} from '../../src/lifecycle/daemon.js';

const dirs: string[] = [];

function temporaryBaseDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'asq-gateway-lifecycle-'));
  dirs.push(dir);
  return dir;
}

function staticDoctorProviders(): ProviderRegistry {
  const capabilities: ProviderCapabilities = {
    available: false,
    verified: false,
    modelSelection: false,
    effortSelection: false,
    isolationLevel: 'best_effort',
    streamingMode: 'none',
    toolBridge: 'none',
    resume: false,
    cancellation: false,
    error: 'binary_unavailable',
  };
  const adapter = (): ProviderAdapter => ({
    probeCapabilities: vi.fn(async (request = { mode: 'static' }) => {
      if (request.mode !== 'static') throw new Error('model_turn_not_allowed');
      return capabilities;
    }),
    start: () => { throw new Error('model_turn_not_allowed'); },
    resume: () => { throw new Error('model_turn_not_allowed'); },
    cancel: vi.fn(async () => {}),
  });
  const providers = new ProviderRegistry();
  registerBuiltInProviders(providers, {
    factories: {
      antigravity: adapter,
      claude: adapter,
      codex: adapter,
      cursor: adapter,
      kimi: adapter,
      opencode: adapter,
    },
  });
  return providers;
}

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('Gateway lifecycle', () => {
  it('closes an opened database when runtime assembly fails', () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const assemblyError = new Error('app assembly failed');
    let db: ReturnType<typeof openGatewayDb> | undefined;

    expect(() => createGatewayRuntime(
      config,
      Buffer.alloc(32),
      Buffer.alloc(32),
      Date.now,
      {
        openDb: (path) => {
          db = openGatewayDb(path);
          return db;
        },
        buildApp: () => { throw assemblyError; },
      },
    )).toThrow(assemblyError);

    expect(db?.raw.open).toBe(false);
  });

  it('preserves the assembly error when database cleanup also fails', () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const assemblyError = new Error('app assembly failed');
    const closeError = new Error('database close failed');

    expect(() => createGatewayRuntime(
      config,
      Buffer.alloc(32),
      Buffer.alloc(32),
      Date.now,
      {
        openDb: (path) => {
          const db = openGatewayDb(path);
          const close = db.close.bind(db);
          db.close = () => {
            close();
            throw closeError;
          };
          return db;
        },
        buildApp: () => { throw assemblyError; },
      },
    )).toThrow(expect.objectContaining({
      errors: [assemblyError, closeError],
      cause: assemblyError,
    }));
  });

  it.each([
    ['partial numeric', '1234garbage'],
    ['whitespace only', ' \n\t '],
    ['zero', '0'],
    ['negative', '-42'],
    ['overflow', String(Number.MAX_SAFE_INTEGER + 1)],
  ])('rejects a %s PID without signaling', async (_description, content) => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    fs.mkdirSync(config.paths.stateDir, { recursive: true });
    fs.writeFileSync(config.paths.pidPath, content);
    const kill = vi.fn();

    await stopGateway({
      baseDir,
      process: { pid: 101, argv: [], kill },
      output: vi.fn(),
    });

    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(config.paths.pidPath)).toBe(false);
  });

  it('accepts a positive safe PID with surrounding whitespace', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    fs.mkdirSync(config.paths.stateDir, { recursive: true });
    fs.writeFileSync(config.paths.pidPath, ' \n 1234\t ');
    const kill = vi.fn();

    await stopGateway({
      baseDir,
      process: { pid: 101, argv: [], kill },
      output: vi.fn(),
    });

    expect(kill).toHaveBeenNthCalledWith(1, 1234, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 1234, 'SIGTERM');
    expect(readPid(config.paths)).toBe(1234);
  });

  it('removes malformed PID files from start and status flows', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    fs.mkdirSync(config.paths.stateDir, { recursive: true });
    fs.writeFileSync(config.paths.pidPath, '1234oops');
    const kill = vi.fn();
    const unref = vi.fn();

    await startGateway({
      baseDir,
      spawn: vi.fn(() => ({ pid: 4321, unref })),
      process: { pid: 101, argv: ['node', '/tmp/gateway-bin.js'], kill },
      output: vi.fn(),
    });
    expect(fs.existsSync(config.paths.pidPath)).toBe(false);

    fs.writeFileSync(config.paths.pidPath, 'not-a-pid');
    await statusGateway({
      baseDir,
      fetch: vi.fn(async () => ({ ok: true, status: 200 })),
      process: { pid: 101, argv: [], kill },
      output: vi.fn(),
    });

    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(config.paths.pidPath)).toBe(false);
  });

  it('removes a stale PID before starting a detached foreground child', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    writePid(config.paths, 999_999);
    fs.writeFileSync(config.paths.configPath, JSON.stringify({
      address: '127.0.0.1',
      port: 30_000,
      web_ui_auth: 'disabled',
    }));
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ pid: 4321, unref }));

    await startGateway({
      baseDir,
      webUiAuth: 'token',
      spawn,
      process: { pid: 101, argv: ['node', '/tmp/gateway-bin.js'], execPath: '/usr/local/bin/node', kill: () => { throw new Error('dead'); } },
    });

    expect(readPid(config.paths)).toBeNull();
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/node', [
      '/tmp/gateway-bin.js',
      'start',
      '--foreground',
      '--address',
      '127.0.0.1',
      '--port',
      '30000',
      '--web-ui-auth',
      'token',
    ], {
      detached: true,
      stdio: 'ignore',
    });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('does nothing when the PID belongs to a live Gateway process', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    writePid(config.paths, 1234);
    const spawn = vi.fn();

    await startGateway({
      baseDir,
      spawn,
      process: { pid: 101, argv: ['node', '/tmp/gateway-bin.js'], execPath: '/usr/local/bin/node', kill: vi.fn() },
    });

    expect(readPid(config.paths)).toBe(1234);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('owns secrets, runtime, PID, and idempotent signal shutdown in the foreground', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const events: string[] = [];
    const signals = new Map<string, () => void>();
    const exits: number[] = [];
    const runtime: GatewayRuntime = {
      interruptUnfinished: () => { events.push('interrupt'); },
      listen: async (host, port) => { events.push(`listen:${host}:${port}`); },
      closeApp: async () => { events.push('app-close'); },
      closeDb: () => { events.push('db-close'); },
    };

    const start = startGateway({
      baseDir,
      foreground: true,
      process: {
        pid: 2468,
        argv: ['node', '/tmp/gateway-bin.js'],
        kill: vi.fn(),
        on: (signal, listener) => { signals.set(signal, listener); },
        exit: (code) => { exits.push(code); },
      },
      createRuntime: () => {
        expect(fs.existsSync(config.paths.masterKeyPath)).toBe(true);
        expect(fs.existsSync(config.paths.adminSecretPath)).toBe(true);
        return runtime;
      },
    });

    await vi.waitFor(() => expect(readPid(config.paths)).toBe(2468));
    signals.get('SIGINT')!();
    signals.get('SIGTERM')!();
    await start;

    expect(events).toEqual([
      'interrupt',
      'listen:0.0.0.0:28772',
      'app-close',
      'db-close',
    ]);
    expect(readPid(config.paths)).toBeNull();
    expect(exits).toEqual([0]);
  });

  it('cleans up PID, runtime, and signal handlers when foreground listen fails', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const off = vi.fn();
    const runtime: GatewayRuntime = {
      interruptUnfinished: vi.fn(),
      listen: async () => { throw new Error('listener failed'); },
      closeApp: vi.fn(async () => {}),
      closeDb: vi.fn(),
    };

    await expect(startGateway({
      baseDir,
      foreground: true,
      process: { pid: 2468, argv: ['node', '/tmp/gateway-bin.js'], kill: vi.fn(), on: vi.fn(), off },
      createRuntime: () => runtime,
    })).rejects.toThrow('listener failed');

    expect(readPid(config.paths)).toBeNull();
    expect(runtime.closeApp).toHaveBeenCalledOnce();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('removes signal handlers even when startup cleanup reports an error', async () => {
    const baseDir = temporaryBaseDir();
    const off = vi.fn();
    const listenerError = new Error('listener failed');
    const cleanupError = new Error('close failed');
    const runtime: GatewayRuntime = {
      interruptUnfinished: vi.fn(),
      listen: async () => { throw listenerError; },
      closeApp: async () => { throw cleanupError; },
      closeDb: vi.fn(),
    };

    const start = startGateway({
      baseDir,
      foreground: true,
      process: { pid: 2468, argv: ['node', '/tmp/gateway-bin.js'], kill: vi.fn(), on: vi.fn(), off },
      createRuntime: () => runtime,
    });

    await expect(start).rejects.toMatchObject({
      errors: [listenerError, cleanupError],
      cause: listenerError,
    });

    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('settles foreground startup with signal cleanup failure and unregisters listeners', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const signals = new Map<string, () => void>();
    const off = vi.fn();
    const closeError = new Error('signal close failed');
    const runtime: GatewayRuntime = {
      interruptUnfinished: vi.fn(),
      listen: vi.fn(async () => {}),
      closeApp: vi.fn(async () => { throw closeError; }),
      closeDb: vi.fn(),
    };
    const processRef = {
      pid: 2468,
      argv: ['node', '/tmp/gateway-bin.js'],
      kill: vi.fn(),
      on: (signal: NodeJS.Signals, listener: () => void) => { signals.set(signal, listener); },
      off,
      exit: vi.fn(),
      exitCode: undefined as number | undefined,
    };

    const start = startGateway({ baseDir, foreground: true, process: processRef, createRuntime: () => runtime });
    await vi.waitFor(() => expect(readPid(config.paths)).toBe(2468));
    signals.get('SIGTERM')!();
    signals.get('SIGINT')!();

    await expect(start).rejects.toBe(closeError);
    expect(runtime.closeApp).toHaveBeenCalledOnce();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processRef.exit).not.toHaveBeenCalled();
    expect(processRef.exitCode).toBe(1);
  });

  it('preserves app and database close failures during signal shutdown cleanup', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const signals = new Map<string, () => void>();
    const off = vi.fn();
    const appCloseError = new Error('app close failed');
    const dbCloseError = new Error('database close failed');
    const runtime: GatewayRuntime = {
      interruptUnfinished: vi.fn(),
      listen: vi.fn(async () => {}),
      closeApp: vi.fn(async () => { throw appCloseError; }),
      closeDb: vi.fn(() => { throw dbCloseError; }),
    };
    const processRef = {
      pid: 2468,
      argv: ['node', '/tmp/gateway-bin.js'],
      kill: vi.fn(),
      on: (signal: NodeJS.Signals, listener: () => void) => { signals.set(signal, listener); },
      off,
      exit: vi.fn(),
      exitCode: undefined as number | undefined,
    };

    const start = startGateway({ baseDir, foreground: true, process: processRef, createRuntime: () => runtime });
    await vi.waitFor(() => expect(readPid(config.paths)).toBe(2468));
    signals.get('SIGTERM')!();

    await expect(start).rejects.toMatchObject({
      errors: [appCloseError, dbCloseError],
    });
    expect(runtime.closeApp).toHaveBeenCalledOnce();
    expect(runtime.closeDb).toHaveBeenCalledOnce();
    expect(readPid(config.paths)).toBeNull();
    expect(off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processRef.exit).not.toHaveBeenCalled();
    expect(processRef.exitCode).toBe(1);
  });

  it('probes the loopback health endpoint and cleans stale status PID files', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    writePid(config.paths, 999_999);
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));

    const status = await statusGateway({
      baseDir,
      fetch,
      process: { pid: 101, argv: [], kill: () => { throw new Error('dead'); } },
    });

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:28772/health');
    expect(readPid(config.paths)).toBeNull();
    expect(status).toEqual({ pid: null, alive: false, health: 'ok' });
  });

  it('mints a bootstrap code locally and opens a fragment URL without leaking the admin secret', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const secret = Buffer.alloc(32, 7);
    fs.mkdirSync(config.paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.paths.adminSecretPath, secret, { mode: 0o600 });
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ mode: 'token' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: 'bootstrap-code' }) });
    const openUrl = vi.fn();

    await openGateway({ baseDir, fetch, openUrl });

    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:28772/admin/auth/mode');
    const request = fetch.mock.calls[1]!;
    expect(request[0]).toBe('http://127.0.0.1:28772/admin/bootstrap/mint');
    expect(request[1]).toEqual({
      method: 'POST',
      headers: { authorization: `Bearer ${secret.toString('base64url')}` },
    });
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:28772/#/bootstrap/bootstrap-code');
    expect(openUrl.mock.calls[0]![0]).not.toContain(secret.toString('base64url'));
  });

  it('opens the Web UI directly when authentication is disabled', async () => {
    const baseDir = temporaryBaseDir();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ mode: 'disabled' }),
    }));
    const openUrl = vi.fn();

    await openGateway({ baseDir, fetch, openUrl });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:28772/admin/auth/mode');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:28772/#/overview');
  });

  it('reports a valid database as reachable without mutating it', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir, coreUrl: 'http://127.0.0.1:29999' });
    fs.mkdirSync(config.paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(config.paths.masterKeyPath, Buffer.alloc(32, 1), { mode: 0o600 });
    fs.writeFileSync(config.paths.adminSecretPath, Buffer.alloc(32, 2), { mode: 0o600 });
    const db = openGatewayDb(config.paths.dbPath);
    db.close();
    const before = fs.readFileSync(config.paths.dbPath);
    const output = vi.fn();
    const fetch = vi.fn(async () => ({ ok: true, status: 200 }));

    const report = await doctorGateway({
      baseDir,
      coreUrl: 'http://127.0.0.1:29999',
      fetch,
      output,
      providers: staticDoctorProviders(),
    });

    expect(report).toMatchObject({
      masterKeyMode: '0600',
      adminSecretMode: '0600',
      database: 'reachable',
      core: 'reachable',
    });
    expect(report.providers).toHaveLength(6);
    expect(fs.readFileSync(config.paths.dbPath)).toEqual(before);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:29999/v1/health');
    expect(output.mock.calls.flat().join('\n')).not.toContain(Buffer.alloc(32, 1).toString('base64url'));
    expect(output.mock.calls.flat().join('\n')).not.toContain(Buffer.alloc(32, 2).toString('base64url'));
  });

  it.each([
    ['corrupt', true],
    ['missing', false],
  ])('reports a %s database as unreachable', async (_description, createCorruptFile) => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    if (createCorruptFile) {
      fs.mkdirSync(config.paths.stateDir, { recursive: true });
      fs.writeFileSync(config.paths.dbPath, 'not a sqlite database');
    }

    const report = await doctorGateway({
      baseDir,
      fetch: vi.fn(async () => ({ ok: true, status: 200 })),
      output: vi.fn(),
      providers: staticDoctorProviders(),
    });

    expect(report.database).toBe('unreachable');
  });

  it('reports an unreadable database as unreachable through the injected probe', async () => {
    const baseDir = temporaryBaseDir();
    const config = resolveGatewayConfig({ baseDir });
    const databaseProbe = vi.fn(() => { throw new Error('EACCES'); });

    const report = await doctorGateway({
      baseDir,
      databaseProbe,
      fetch: vi.fn(async () => ({ ok: true, status: 200 })),
      output: vi.fn(),
      providers: staticDoctorProviders(),
    });

    expect(databaseProbe).toHaveBeenCalledWith(config.paths.dbPath);
    expect(report.database).toBe('unreachable');
  });
});
