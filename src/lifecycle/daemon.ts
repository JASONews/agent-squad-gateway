import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  ensureGatewayConfigFile,
  gatewayLoopbackOrigin,
  loadGatewayConfig,
  type GatewayConfig,
  type GatewayWebUiAuthMode,
} from '../config/config.js';
import { ClientRepository } from '../control-plane/clients.js';
import { CredentialService } from '../control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../control-plane/db.js';
import { ExtensionRepository } from '../control-plane/extensions.js';
import { GrantRepository } from '../control-plane/grants.js';
import { RunRepository } from '../control-plane/runs.js';
import { TargetRepository } from '../control-plane/targets.js';
import {
  BUILT_IN_PROVIDER_COMMANDS,
  registerBuiltInProviders,
} from '../provider-runtime/register-providers.js';
import { resolveProviderCommand } from '../provider-runtime/command-discovery.js';
import { ProviderRegistry } from '../provider-runtime/registry.js';
import type { ProviderCapabilities } from '../provider-runtime/types.js';
import { AdminAuthService } from '../security/admin-auth.js';
import { ensureSecretFile, readSecretFile } from '../security/secret-files.js';
import { buildGatewayApp } from '../server/app.js';
import { inspectPid, removePid, writePid } from './pidfile.js';

const SECRET_BYTES = 32;
const BOOTSTRAP_CODE = /^[A-Za-z0-9_-]+$/;

export interface GatewayRuntime {
  interruptUnfinished(): void;
  listen(host: GatewayConfig['host'], port: number): Promise<void>;
  closeApp(): Promise<void>;
  closeDb(): void;
}

export interface GatewayRuntimeAssemblyFactories {
  openDb?: typeof openGatewayDb;
  buildApp?: typeof buildGatewayApp;
}

interface GatewayProcess {
  pid: number;
  argv: string[];
  execPath?: string;
  kill(pid: number, signal?: number | NodeJS.Signals): void;
  on?(signal: NodeJS.Signals, listener: () => void): void;
  off?(signal: NodeJS.Signals, listener: () => void): void;
  exit?(code: number): void;
  exitCode?: string | number | null;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

type GatewayFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<HttpResponse>;
type GatewaySpawn = (command: string, args: string[], options: { detached: true; stdio: 'ignore' }) => Pick<ChildProcess, 'pid' | 'unref'>;

export interface GatewayLifecycleOptions {
  baseDir?: string;
  address?: string;
  port?: number;
  coreUrl?: string;
  webUiAuth?: GatewayWebUiAuthMode;
  fetch?: GatewayFetch;
  spawn?: GatewaySpawn;
  openUrl?: (url: string) => void;
  process?: GatewayProcess;
  output?: (line: string) => void;
  clock?: () => number;
  databaseProbe?: (path: string) => void;
  providers?: ProviderRegistry;
  resolveProviderBinary?: (cli: string) => string | null;
  createRuntime?: (config: GatewayConfig, masterKey: Buffer, adminSecret: Buffer, clock: () => number) => GatewayRuntime;
}

export interface GatewayStatus {
  pid: number | null;
  alive: boolean;
  health: 'ok' | 'unreachable' | `status:${number}`;
}

export interface GatewayDoctorReport {
  masterKeyMode: string;
  adminSecretMode: string;
  database: 'reachable' | 'unreachable';
  core: 'reachable' | 'unreachable' | `status:${number}`;
  providers: GatewayDoctorProvider[];
}

export interface GatewayDoctorProvider {
  cli: string;
  binaryPath: string | null;
  available: boolean;
  version: string | null;
  staticCeiling: {
    modelSelection: boolean;
    effortSelection: boolean;
    isolationLevel: ProviderCapabilities['isolationLevel'];
    streamingMode: ProviderCapabilities['streamingMode'];
    toolBridge: ProviderCapabilities['toolBridge'];
    resume: boolean;
    cancellation: boolean;
  };
  targets: Array<{
    id: string;
    enabled: boolean;
    persistedVersion: string | null;
    verifiedAt: string | null;
    status: 'verified' | 'verify-required' | 'unavailable';
  }>;
}

interface DoctorTargetRow {
  id: string;
  cli: string;
  enabled: number;
  capability_version: string | null;
  capability_verified_at: string | null;
  capability_error: string | null;
}

const defaultFetch: GatewayFetch = async (url, init) => fetch(url, init);
const defaultProcess: GatewayProcess = {
  pid: process.pid,
  argv: process.argv,
  execPath: process.execPath,
  kill: (pid, signal) => process.kill(pid, signal),
  on: (signal, listener) => { process.on(signal, listener); },
  off: (signal, listener) => { process.off(signal, listener); },
  exit: (code) => { process.exit(code); },
  get exitCode() { return process.exitCode; },
  set exitCode(code) { process.exitCode = code; },
};

export async function startGateway(options: GatewayLifecycleOptions & { foreground?: boolean } = {}): Promise<void> {
  ensureGatewayConfigFile(options.baseDir);
  const config = resolveConfig(options);
  const processRef = options.process ?? defaultProcess;
  const output = options.output ?? console.error;
  const existingPid = readLifecyclePid(config.paths);

  if (existingPid !== null) {
    if (isProcessAlive(existingPid, processRef)) {
      output(`agent-squad-gateway already running (pid ${existingPid})`);
      return;
    }
    removePid(config.paths);
  }

  if (!options.foreground) {
    const child = (options.spawn ?? defaultSpawn)(
      processRef.execPath ?? process.execPath,
      [
        processRef.argv[1]!,
        'start',
        '--foreground',
        '--address',
        config.host,
        '--port',
        String(config.port),
        '--web-ui-auth',
        config.webUiAuth,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    output(`agent-squad-gateway started${child.pid ? ` (pid ${child.pid})` : ''}`);
    return;
  }

  const masterKey = ensureSecretFile(config.paths.masterKeyPath, SECRET_BYTES);
  const adminSecret = ensureSecretFile(config.paths.adminSecretPath, SECRET_BYTES);
  const runtime = (options.createRuntime ?? createGatewayRuntime)(
    config,
    masterKey,
    adminSecret,
    options.clock ?? Date.now,
  );
  let shutdown: Promise<void> | undefined;
  let signalHandled = false;
  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: unknown) => void = () => {};
  const shutdownComplete = new Promise<void>((resolve, reject) => {
    resolveShutdown = resolve;
    rejectShutdown = reject;
  });

  const close = (): Promise<void> => {
    shutdown ??= closeRuntime(runtime, config.paths);
    return shutdown;
  };

  const handleSignal = (): void => {
    if (signalHandled) return;
    signalHandled = true;
    void close().then(resolveShutdown, rejectShutdown);
  };

  processRef.on?.('SIGINT', handleSignal);
  processRef.on?.('SIGTERM', handleSignal);

  try {
    runtime.interruptUnfinished();
    writePid(config.paths, processRef.pid);
    await runtime.listen(config.host, config.port);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Gateway startup failed and cleanup also failed',
        { cause: error },
      );
    } finally {
      processRef.off?.('SIGINT', handleSignal);
      processRef.off?.('SIGTERM', handleSignal);
    }
    throw error;
  }

  try {
    await shutdownComplete;
  } catch (error) {
    processRef.exitCode = 1;
    throw error;
  } finally {
    processRef.off?.('SIGINT', handleSignal);
    processRef.off?.('SIGTERM', handleSignal);
  }
  processRef.exit?.(0);
}

async function closeRuntime(runtime: GatewayRuntime, paths: GatewayConfig['paths']): Promise<void> {
  const errors: unknown[] = [];
  try {
    await runtime.closeApp();
  } catch (error) {
    errors.push(error);
  }
  try {
    runtime.closeDb();
  } catch (error) {
    errors.push(error);
  }
  try {
    removePid(paths);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Gateway runtime shutdown failed');
}

export async function stopGateway(options: GatewayLifecycleOptions = {}): Promise<void> {
  const config = resolveConfig(options);
  const processRef = options.process ?? defaultProcess;
  const output = options.output ?? console.error;
  const pid = readLifecyclePid(config.paths);
  if (pid === null) {
    output('agent-squad-gateway is not running');
    return;
  }
  if (!isProcessAlive(pid, processRef)) {
    removePid(config.paths);
    output('removed stale Gateway PID file');
    return;
  }
  processRef.kill(pid, 'SIGTERM');
  output(`sent SIGTERM to Gateway (pid ${pid})`);
}

export async function statusGateway(options: GatewayLifecycleOptions = {}): Promise<GatewayStatus> {
  const config = resolveConfig(options);
  const processRef = options.process ?? defaultProcess;
  const pid = readLifecyclePid(config.paths);
  const alive = pid !== null && isProcessAlive(pid, processRef);
  if (pid !== null && !alive) removePid(config.paths);
  const health = await probe(options.fetch ?? defaultFetch, `${gatewayLoopbackOrigin(config)}/health`);
  const status = { pid: alive ? pid : null, alive, health };
  (options.output ?? console.error)(`pid: ${status.pid ?? '-'}, alive: ${status.alive}, health: ${status.health}`);
  return status;
}

export async function openGateway(options: GatewayLifecycleOptions = {}): Promise<void> {
  const config = resolveConfig(options);
  const origin = gatewayLoopbackOrigin(config);
  const modeResponse = await (options.fetch ?? defaultFetch)(`${origin}/admin/auth/mode`);
  if (!modeResponse.ok || !modeResponse.json) {
    throw new Error(`Gateway Web UI auth mode request failed (${modeResponse.status})`);
  }
  const mode = await modeResponse.json();
  if (!isWebUiAuthMode(mode)) throw new Error('Gateway returned an invalid Web UI auth mode');
  if (mode.mode === 'disabled') {
    (options.openUrl ?? openInBrowser)(`${origin}/#/overview`);
    return;
  }

  const adminSecret = readSecretFile(config.paths.adminSecretPath);
  if (adminSecret.length !== SECRET_BYTES) throw new Error('invalid Gateway admin secret');
  const response = await (options.fetch ?? defaultFetch)(`${origin}/admin/bootstrap/mint`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret.toString('base64url')}` },
  });
  if (!response.ok || !response.json) throw new Error(`Gateway bootstrap mint failed (${response.status})`);
  const body = await response.json();
  const code = isBootstrapCode(body) ? body.code : null;
  if (!code) throw new Error('Gateway bootstrap mint returned an invalid code');
  (options.openUrl ?? openInBrowser)(`${origin}/#/bootstrap/${code}`);
}

export async function doctorGateway(options: GatewayLifecycleOptions = {}): Promise<GatewayDoctorReport> {
  const config = resolveConfig(options);
  const providers = options.providers ?? new ProviderRegistry();
  if (!options.providers) registerBuiltInProviders(providers);
  let providerReport: GatewayDoctorProvider[];
  try {
    providerReport = await inspectProviders(
      providers,
      readDoctorTargets(config.paths.dbPath),
      options.resolveProviderBinary ?? resolveProviderBinary,
    );
  } finally {
    await providers.dispose();
  }
  const report: GatewayDoctorReport = {
    masterKeyMode: fileMode(config.paths.masterKeyPath),
    adminSecretMode: fileMode(config.paths.adminSecretPath),
    database: databaseReachability(options.databaseProbe ?? defaultDatabaseProbe, config.paths.dbPath),
    core: asCoreReachability(await probe(options.fetch ?? defaultFetch, `${config.coreUrl}/v1/health`)),
    providers: providerReport,
  };
  const output = options.output ?? console.error;
  output(`master.key mode: ${report.masterKeyMode}`);
  output(`admin-secret mode: ${report.adminSecretMode}`);
  output(`database: ${report.database}`);
  output(`Core: ${report.core}`);
  for (const provider of report.providers) {
    const targets = provider.targets.length === 0
      ? 'not-configured'
      : provider.targets.map((target) => `${target.id}:${target.status}`).join(',');
    output(
      `provider ${provider.cli}: binary=${provider.binaryPath ?? 'missing'} version=${provider.version ?? 'unknown'} targets=${targets}`,
    );
  }
  return report;
}

export function createGatewayRuntime(
  config: GatewayConfig,
  masterKey: Buffer,
  adminSecret: Buffer,
  clock: () => number,
  factories: GatewayRuntimeAssemblyFactories = {},
): GatewayRuntime {
  const db = (factories.openDb ?? openGatewayDb)(config.paths.dbPath);
  try {
    const clients = new ClientRepository(db);
    const credentials = new CredentialService(db, masterKey);
    const targets = new TargetRepository(db);
    const grants = new GrantRepository(db);
    const extensions = new ExtensionRepository(db);
    const runs = new RunRepository(db);
    const adminAuth = new AdminAuthService(db, adminSecret, { now: clock });
    const app = (factories.buildApp ?? buildGatewayApp)({
      config,
      db,
      clients,
      credentials,
      targets,
      grants,
      extensions,
      runs,
      adminAuth,
      scanCapabilitiesOnReady: true,
    });
    return asRuntime(app, db);
  } catch (error) {
    try {
      db.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Gateway runtime assembly failed and database cleanup also failed',
        { cause: error },
      );
    }
    throw error;
  }
}

function asRuntime(app: FastifyInstance, db: GatewayDb): GatewayRuntime {
  return {
    // Retention's onReady hook reconciles Runs and response chains in one transaction.
    interruptUnfinished: () => {},
    listen: async (host, port) => { await app.listen({ host, port }); },
    closeApp: async () => { await app.close(); },
    closeDb: () => { db.close(); },
  };
}

function defaultSpawn(command: string, args: string[], options: { detached: true; stdio: 'ignore' }): Pick<ChildProcess, 'pid' | 'unref'> {
  return spawnChild(command, args, options);
}

function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'darwin'
    ? [url]
    : process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
  const child = spawnChild(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function resolveConfig(options: GatewayLifecycleOptions): GatewayConfig {
  return loadGatewayConfig({
    baseDir: options.baseDir,
    address: options.address,
    port: options.port,
    coreUrl: options.coreUrl,
    webUiAuth: options.webUiAuth,
  });
}

function isWebUiAuthMode(value: unknown): value is { mode: GatewayWebUiAuthMode } {
  if (typeof value !== 'object' || value === null || !('mode' in value)) return false;
  return value.mode === 'disabled' || value.mode === 'token';
}

function readLifecyclePid(paths: GatewayConfig['paths']): number | null {
  const result = inspectPid(paths);
  if (result.kind === 'malformed') removePid(paths);
  return result.kind === 'valid' ? result.pid : null;
}

function isProcessAlive(pid: number, processRef: GatewayProcess): boolean {
  try {
    processRef.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probe(fetch: GatewayFetch, url: string): Promise<'ok' | 'unreachable' | `status:${number}`> {
  try {
    const response = await fetch(url);
    return response.ok ? 'ok' : `status:${response.status}`;
  } catch {
    return 'unreachable';
  }
}

function asCoreReachability(value: 'ok' | 'unreachable' | `status:${number}`): GatewayDoctorReport['core'] {
  return value === 'ok' ? 'reachable' : value;
}

function fileMode(path: string): string {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
  } catch {
    return 'missing';
  }
}

function defaultDatabaseProbe(path: string): void {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    database.prepare('SELECT name FROM sqlite_schema LIMIT 1').get();
  } finally {
    database.close();
  }
}

function databaseReachability(probeDatabase: (path: string) => void, path: string): GatewayDoctorReport['database'] {
  try {
    probeDatabase(path);
    return 'reachable';
  } catch {
    return 'unreachable';
  }
}

async function inspectProviders(
  providers: ProviderRegistry,
  targets: DoctorTargetRow[],
  resolveBinary: (cli: string) => string | null,
): Promise<GatewayDoctorProvider[]> {
  const report: GatewayDoctorProvider[] = [];
  for (const cli of providers.list()) {
    let capabilities: ProviderCapabilities;
    try {
      capabilities = await providers.require(cli).probeCapabilities({ mode: 'static' });
    } catch {
      capabilities = unavailableDoctorCapabilities();
    }
    const matchingTargets = targets.filter((target) => target.cli === cli);
    report.push({
      cli,
      binaryPath: resolveBinary(cli),
      available: capabilities.available,
      version: capabilities.version ?? null,
      staticCeiling: {
        modelSelection: capabilities.modelSelection,
        effortSelection: capabilities.effortSelection,
        isolationLevel: capabilities.isolationLevel,
        streamingMode: capabilities.streamingMode,
        toolBridge: capabilities.toolBridge,
        resume: capabilities.resume,
        cancellation: capabilities.cancellation,
      },
      targets: matchingTargets.map((target) => ({
        id: target.id,
        enabled: target.enabled === 1,
        persistedVersion: target.capability_version,
        verifiedAt: target.capability_verified_at,
        status: !capabilities.available
          ? 'unavailable'
          : target.capability_version === capabilities.version
            && target.capability_verified_at !== null
            && target.capability_error === null
            ? 'verified'
            : 'verify-required',
      })),
    });
  }
  return report;
}

function readDoctorTargets(path: string): DoctorTargetRow[] {
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    return database.prepare(`
      SELECT id, cli, enabled, capability_version, capability_verified_at, capability_error
      FROM invocation_targets
      ORDER BY id
    `).all() as DoctorTargetRow[];
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function resolveProviderBinary(cli: string): string | null {
  const command = BUILT_IN_PROVIDER_COMMANDS[cli as keyof typeof BUILT_IN_PROVIDER_COMMANDS];
  return command ? resolveProviderCommand(command) : null;
}

function unavailableDoctorCapabilities(): ProviderCapabilities {
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
  };
}

function isBootstrapCode(value: unknown): value is { code: string } {
  return typeof value === 'object'
    && value !== null
    && 'code' in value
    && typeof value.code === 'string'
    && BOOTSTRAP_CODE.test(value.code);
}
