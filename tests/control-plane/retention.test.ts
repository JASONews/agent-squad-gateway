import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { type GatewayDb, openGatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { ResponseSessionRepository } from '../../src/control-plane/response-sessions.js';
import {
  RetentionService,
  type RetentionLifecycle,
  type RetentionWorkspace,
  type RetentionWorkspaceOutcome,
} from '../../src/control-plane/retention.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';
import { buildGatewayApp } from '../../src/server/app.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const EXPIRED = '2026-06-01T00:00:00.000Z';
const FRESH = '2026-07-01T00:00:00.000Z';
const OLD_TERMINAL = '2026-06-01T00:00:00.000Z';

let db: GatewayDb | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  db?.close();
  db = undefined;
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

class FakeRetentionWorkspace implements RetentionWorkspace {
  readonly calls: string[][] = [];
  readonly outcomes = new Map<string, RetentionWorkspaceOutcome['status']>();
  wait: Promise<void> | undefined;

  async cleanupForRetention(paths: string[]): Promise<RetentionWorkspaceOutcome[]> {
    this.calls.push([...paths]);
    await this.wait;
    return paths.map((path) => ({ path, status: this.outcomes.get(path) ?? 'unmanaged' }));
  }
}

function open(): { database: GatewayDb; sessions: ResponseSessionRepository; workspaces: FakeRetentionWorkspace } {
  db = openGatewayDb(':memory:');
  return {
    database: db,
    sessions: new ResponseSessionRepository(db),
    workspaces: new FakeRetentionWorkspace(),
  };
}

function seedRun(
  database: GatewayDb,
  id: string,
  status: string,
  completedAt: string | null = null,
): void {
  database.prepare(`
    INSERT INTO runs (
      id, extension_id, target_id, endpoint, status, queued_at, started_at, completed_at
    ) VALUES (?, 'openai', 'target-a', '/v1/responses', ?, ?, ?, ?)
  `).run(id, status, EXPIRED, status === 'queued' ? null : EXPIRED, completedAt);
}

function expireResponse(database: GatewayDb, responseId: string): void {
  database.prepare('UPDATE response_sessions SET expires_at = ? WHERE response_id = ?')
    .run(EXPIRED, responseId);
}

function seedClient(database: GatewayDb): void {
  database.prepare(`
    INSERT INTO clients (id, name, status, created_at, updated_at)
    VALUES ('client-a', 'Client A', 'active', ?, ?)
  `).run(EXPIRED, EXPIRED);
}

function seedIdempotency(
  database: GatewayDb,
  digest: string,
  runId: string,
  status: 'active' | 'completed' | 'failed',
  expiresAt = EXPIRED,
): void {
  database.prepare(`
    INSERT INTO idempotency_keys (
      client_id, key_digest, request_hash, run_id, response_id, status, expires_at
    ) VALUES ('client-a', ?, 'request-hash', ?, NULL, ?, ?)
  `).run(digest, runId, status, expiresAt);
}

function target(overrides: Partial<InvocationTarget> = {}): InvocationTarget {
  return {
    id: 'target-a',
    aliases: [],
    cli: 'fake',
    nativeModel: 'fake',
    reasoningEffort: null,
    enabled: true,
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 8,
    queueTimeoutMs: 1_000,
    runTimeoutMs: null,
    fixedWorkspace: null,
    capabilityVersion: null,
    capabilityVerifiedAt: null,
    capabilities: null,
    capabilityError: null,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
    ...overrides,
  };
}

describe('RetentionService', () => {
  it('atomically interrupts uncertain Runs and terminally fails every continuing response chain', async () => {
    const { database, sessions, workspaces } = open();
    seedRun(database, 'run-queued', 'queued');
    seedRun(database, 'run-running', 'running');
    seedRun(database, 'run-complete', 'completed', EXPIRED);
    sessions.create({ responseId: 'resp-root', targetId: 'target-a', now: FRESH });
    sessions.acquireContinuation('resp-root', 'target-a', FRESH);
    sessions.completeContinuation({
      parentResponseId: 'resp-root',
      childResponseId: 'resp-child',
      now: FRESH,
    });
    sessions.acquireContinuation('resp-child', 'target-a', FRESH);

    const retention = new RetentionService(database, sessions, workspaces);
    const result = await retention.reconcileStartup(NOW);

    expect(result).toMatchObject({ interruptedRuns: 2, terminalResponseChains: 1 });
    expect(['run-queued', 'run-running'].map((id) => new RunRepository(database).get(id)?.status))
      .toEqual(['interrupted', 'interrupted']);
    expect(sessions.get('resp-root')?.state).toBe('terminal_failure');
    expect(sessions.get('resp-child')?.state).toBe('terminal_failure');
    expect(new RunRepository(database).get('run-complete')?.status).toBe('completed');
  });

  it('rolls back Run interruption when response reconciliation fails', async () => {
    const { database, sessions, workspaces } = open();
    seedRun(database, 'run-running', 'running');
    sessions.create({ responseId: 'resp-root', targetId: 'target-a', now: FRESH });
    sessions.acquireContinuation('resp-root', 'target-a', FRESH);
    database.raw.exec(`
      CREATE TRIGGER fail_response_reconcile
      BEFORE UPDATE OF state ON response_sessions
      WHEN NEW.state = 'terminal_failure'
      BEGIN SELECT RAISE(ABORT, 'forced reconciliation failure'); END;
    `);

    const retention = new RetentionService(database, sessions, workspaces);
    await expect(retention.reconcileStartup(NOW)).rejects.toThrow('forced reconciliation failure');

    expect(new RunRepository(database).get('run-running')?.status).toBe('running');
    expect(sessions.get('resp-root')?.state).toBe('continuing');
  });

  it('deduplicates workspace cleanup, purges fixed/no-workspace metadata, and retries failed managed cleanup', async () => {
    const { database, sessions, workspaces } = open();
    const shared = '/managed/responses/shared';
    const failed = '/managed/responses/retry';
    const fixed = '/srv/project';
    workspaces.outcomes.set(shared, 'removed');
    workspaces.outcomes.set(failed, 'retry');
    workspaces.outcomes.set(fixed, 'unmanaged');

    sessions.create({ responseId: 'resp-shared-a', targetId: 'target-a', workspacePath: shared, now: EXPIRED });
    sessions.create({ responseId: 'resp-shared-b', targetId: 'target-a', workspacePath: shared, now: EXPIRED });
    sessions.create({ responseId: 'resp-fixed', targetId: 'target-a', workspacePath: fixed, now: EXPIRED });
    sessions.create({ responseId: 'resp-retry', targetId: 'target-a', workspacePath: failed, now: EXPIRED });
    sessions.create({ responseId: 'resp-tombstone', targetId: 'target-a', store: false, now: EXPIRED });
    for (const id of ['resp-shared-a', 'resp-shared-b', 'resp-fixed', 'resp-retry', 'resp-tombstone']) {
      expireResponse(database, id);
    }

    const retention = new RetentionService(database, sessions, workspaces);
    const result = await retention.sweep(NOW);

    expect(workspaces.calls).toEqual([[failed, shared, fixed]]);
    expect(result).toMatchObject({ deletedResponses: 4, deletedWorkspaces: 1 });
    expect(sessions.get('resp-shared-a')).toBeUndefined();
    expect(sessions.get('resp-shared-b')).toBeUndefined();
    expect(sessions.get('resp-fixed')).toBeUndefined();
    expect(sessions.get('resp-tombstone')).toBeUndefined();
    sessions.create({ responseId: 'resp-fixed', targetId: 'target-a', now: FRESH });
    expect(sessions.get('resp-fixed')).toEqual(expect.objectContaining({ state: 'open' }));
    expect(database.prepare('SELECT response_id FROM response_sessions WHERE response_id = ?').get('resp-retry'))
      .toBeDefined();
    expect(sessions.get('resp-retry')).toBeUndefined();
    expect(() => sessions.acquireContinuation('resp-retry', 'target-a', NOW.toISOString()))
      .toThrow('response_not_found');
  });

  it('deletes metadata in foreign-key-safe order while preserving active replay rows and recent Runs', async () => {
    const { database, sessions, workspaces } = open();
    seedClient(database);
    seedRun(database, 'run-expired-idem', 'completed', OLD_TERMINAL);
    seedRun(database, 'run-active-idem', 'completed', OLD_TERMINAL);
    seedRun(database, 'run-unreferenced', 'failed', OLD_TERMINAL);
    seedRun(database, 'run-recent', 'completed', '2026-07-01T00:00:00.000Z');
    seedRun(database, 'run-old-queued', 'queued');
    seedIdempotency(database, 'expired', 'run-expired-idem', 'completed');
    seedIdempotency(database, 'active', 'run-active-idem', 'active');
    database.prepare(`
      INSERT INTO admin_sessions (token_hash, csrf_hash, expires_at, created_at)
      VALUES ('expired-admin', 'csrf', ?, ?), ('fresh-admin', 'csrf', ?, ?)
    `).run(EXPIRED, EXPIRED, '2026-08-01T00:00:00.000Z', FRESH);

    const result = await new RetentionService(database, sessions, workspaces).sweep(NOW);

    expect(result).toMatchObject({ deletedIdempotencyKeys: 1, deletedRuns: 2, deletedAdminSessions: 1 });
    expect(database.prepare('SELECT key_digest FROM idempotency_keys ORDER BY key_digest').all())
      .toEqual([{ key_digest: 'active' }]);
    expect(database.prepare('SELECT id FROM runs ORDER BY id').all()).toEqual([
      { id: 'run-active-idem' },
      { id: 'run-old-queued' },
      { id: 'run-recent' },
    ]);
    expect(database.prepare('SELECT token_hash FROM admin_sessions').all()).toEqual([{ token_hash: 'fresh-admin' }]);
  });

  it('keeps continuing chains active and preserves content-free tombstones until expiry', async () => {
    const { database, sessions, workspaces } = open();
    sessions.create({ responseId: 'resp-active', targetId: 'target-a', now: EXPIRED });
    expireResponse(database, 'resp-active');
    sessions.acquireContinuation('resp-active', 'target-a', '2026-05-31T23:59:59.000Z');
    const tombstone = sessions.create({ responseId: 'resp-tombstone', targetId: 'target-a', store: false, now: FRESH });

    await new RetentionService(database, sessions, workspaces).sweep(NOW);

    expect(sessions.get('resp-active')?.state).toBe('continuing');
    expect(sessions.get('resp-tombstone')).toEqual(expect.objectContaining({
      stored: false,
      state: 'not_stored',
      nativeSessionId: null,
      workspacePath: null,
    }));
  });

  it('rejects overlapping sweeps without starting a second cleanup', async () => {
    const { database, sessions, workspaces } = open();
    sessions.create({ responseId: 'resp-expired', targetId: 'target-a', workspacePath: '/managed/responses/a', now: EXPIRED });
    expireResponse(database, 'resp-expired');
    let release!: () => void;
    workspaces.wait = new Promise<void>((resolve) => { release = resolve; });

    const retention = new RetentionService(database, sessions, workspaces);
    const first = retention.sweep(NOW);
    await vi.waitFor(() => expect(workspaces.calls).toHaveLength(1));
    await expect(retention.sweep(NOW)).rejects.toThrow('retention_sweep_in_progress');
    release();
    await first;
    expect(workspaces.calls).toHaveLength(1);
  });

  it('installs exactly one unrefed hourly timer and stops it idempotently', () => {
    const { database, sessions, workspaces } = open();
    const timer = { unref: vi.fn() };
    const setIntervalFn = vi.fn(() => timer);
    const clearIntervalFn = vi.fn();
    const retention = new RetentionService(database, sessions, workspaces, {
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    retention.start();
    retention.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    retention.stop();
    retention.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it('waits for an active sweep on stop and skips overlapping timer ticks', async () => {
    const { database, sessions, workspaces } = open();
    sessions.create({
      responseId: 'resp-active-stop',
      targetId: 'target-a',
      workspacePath: '/managed/responses/active-stop',
      now: EXPIRED,
    });
    expireResponse(database, 'resp-active-stop');
    let release!: () => void;
    workspaces.wait = new Promise<void>((resolve) => { release = resolve; });
    let timerCallback!: () => void;
    const timer = { unref: vi.fn() };
    const onTimerError = vi.fn();
    const retention = new RetentionService(database, sessions, workspaces, {
      setInterval: (callback) => {
        timerCallback = callback;
        return timer;
      },
      clearInterval: vi.fn(),
      onTimerError,
    });

    retention.start();
    const sweep = retention.sweep(NOW);
    await vi.waitFor(() => expect(workspaces.calls).toHaveLength(1));
    timerCallback();
    await Promise.resolve();
    expect(workspaces.calls).toHaveLength(1);
    expect(onTimerError).not.toHaveBeenCalled();

    let stopped = false;
    const stopping = retention.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([sweep, stopping]);
    expect(stopped).toBe(true);
  });

  it('reports scheduled sweep failures without throwing and retries on a later tick', async () => {
    const { database, sessions } = open();
    sessions.create({
      responseId: 'resp-timer-retry',
      targetId: 'target-a',
      workspacePath: '/managed/responses/timer-retry',
      now: EXPIRED,
    });
    expireResponse(database, 'resp-timer-retry');
    const failure = new Error('scheduled cleanup failed');
    let attempts = 0;
    const workspaces: RetentionWorkspace = {
      cleanupForRetention: vi.fn(async (paths) => {
        attempts += 1;
        if (attempts !== 2) throw failure;
        return paths.map((path) => ({ path, status: 'unmanaged' as const }));
      }),
    };
    let timerCallback!: () => void;
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const retention = new RetentionService(database, sessions, workspaces, {
      setInterval: (callback) => {
        timerCallback = callback;
        return { unref: vi.fn() };
      },
      clearInterval: vi.fn(),
    });

    retention.start();
    timerCallback();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith(
      'Gateway retention sweep failed',
      failure,
    ));

    timerCallback();
    await vi.waitFor(() => expect(attempts).toBe(2));
    await vi.waitFor(() => expect(database.prepare(
      'SELECT response_id FROM response_sessions WHERE response_id = ?',
    ).get('resp-timer-retry')).toBeUndefined());

    sessions.create({
      responseId: 'resp-direct-reject',
      targetId: 'target-a',
      workspacePath: '/managed/responses/direct-reject',
      now: EXPIRED,
    });
    expireResponse(database, 'resp-direct-reject');
    await expect(retention.sweep(NOW)).rejects.toBe(failure);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    await retention.stop();
  });
});

describe('WorkspaceManager retention cleanup', () => {
  it('removes marked managed workspaces but never removes fixed workspaces', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-workspace-'));
    tempDirs.push(baseDir);
    const root = join(baseDir, 'managed');
    const fixed = join(baseDir, 'fixed');
    await mkdir(fixed);
    const manager = new WorkspaceManager(root, { getFixedWorkspaces: () => [fixed] });
    const managed = await manager.createResponse(target(), 'resp-managed');
    await managed.release();

    const outcomes = await manager.cleanupForRetention([managed.path, fixed]);

    expect(outcomes).toEqual([
      { path: managed.path, status: 'removed' },
      { path: fixed, status: 'unmanaged' },
    ]);
    await expect(access(managed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(fixed)).resolves.toBeUndefined();
  });

  it('retains a managed workspace when safeguarded cleanup fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-workspace-fail-'));
    tempDirs.push(baseDir);
    const manager = new WorkspaceManager(join(baseDir, 'managed'), {
      getFixedWorkspaces: () => [],
      testHooks: {
        beforeAtomicDetach: ({ reason }) => {
          if (reason === 'cleanup') throw new Error('forced cleanup failure');
        },
      },
    });
    const managed = await manager.createResponse(target(), 'resp-retry');
    await managed.release();

    await expect(manager.cleanupForRetention([managed.path])).resolves.toEqual([
      { path: managed.path, status: 'retry' },
    ]);
    await expect(access(managed.path)).resolves.toBeUndefined();
  });

  it('retries a missing marker while retaining workspace content and response metadata', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-workspace-marker-'));
    tempDirs.push(baseDir);
    const manager = new WorkspaceManager(join(baseDir, 'managed'), {
      getFixedWorkspaces: () => [],
    });
    const managed = await manager.createResponse(target(), 'resp-missing-marker');
    const contentPath = join(managed.path, 'provider-output.txt');
    await writeFile(contentPath, 'retained provider content');
    await managed.release();
    await unlink(join(managed.path, '.gateway-workspace'));

    await expect(manager.cleanupForRetention([managed.path])).resolves.toEqual([
      { path: managed.path, status: 'retry' },
    ]);

    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({
      responseId: 'resp-missing-marker',
      targetId: 'target-a',
      workspacePath: managed.path,
      now: EXPIRED,
    });
    expireResponse(db, 'resp-missing-marker');
    const result = await new RetentionService(db, sessions, manager).sweep(NOW);

    expect(result).toMatchObject({ deletedResponses: 0, deletedWorkspaces: 0 });
    await expect(access(managed.path)).resolves.toBeUndefined();
    await expect(readFile(contentPath, 'utf8')).resolves.toBe('retained provider content');
    expect(db.prepare('SELECT response_id FROM response_sessions WHERE response_id = ?')
      .get('resp-missing-marker')).toBeDefined();
  });
});

describe('Gateway retention lifecycle', () => {
  it('reconciles and sweeps before ready, starts afterward, and stops on close', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-app-'));
    tempDirs.push(baseDir);
    db = openGatewayDb(':memory:');
    const calls: string[] = [];
    const retention: RetentionLifecycle = {
      reconcileStartup: vi.fn(async () => { calls.push('reconcile'); return undefined; }),
      sweep: vi.fn(async () => { calls.push('sweep'); return undefined; }),
      start: vi.fn(() => { calls.push('start'); }),
      stop: vi.fn(() => { calls.push('stop'); }),
    };
    const clients = new ClientRepository(db);
    const targets = new TargetRepository(db);
    const app = buildGatewayApp({
      config: resolveGatewayConfig({ baseDir }),
      db,
      clients,
      credentials: new CredentialService(db, Buffer.alloc(32, 1)),
      targets,
      grants: new GrantRepository(db),
      extensions: new ExtensionRepository(db),
      runs: new RunRepository(db),
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 2)),
      retention,
    });

    await app.ready();
    expect(calls).toEqual(['reconcile', 'sweep', 'start']);
    await app.close();
    expect(calls).toEqual(['reconcile', 'sweep', 'start', 'stop']);
  });

  it('does not start retention when initial sweep fails and preserves the startup error', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-app-fail-'));
    tempDirs.push(baseDir);
    db = openGatewayDb(':memory:');
    const failure = new Error('initial retention failed');
    const retention: RetentionLifecycle = {
      reconcileStartup: vi.fn(async () => undefined),
      sweep: vi.fn(async () => { throw failure; }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const app = buildGatewayApp({
      config: resolveGatewayConfig({ baseDir }),
      db,
      clients: new ClientRepository(db),
      credentials: new CredentialService(db, Buffer.alloc(32, 1)),
      targets: new TargetRepository(db),
      grants: new GrantRepository(db),
      extensions: new ExtensionRepository(db),
      runs: new RunRepository(db),
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 2)),
      retention,
    });

    await expect(app.ready()).rejects.toBe(failure);
    expect(retention.start).not.toHaveBeenCalled();
    await app.close();
  });

  it('waits for asynchronous retention stop before app close resolves', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'asq-retention-app-drain-'));
    tempDirs.push(baseDir);
    db = openGatewayDb(':memory:');
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const retention: RetentionLifecycle = {
      reconcileStartup: vi.fn(async () => undefined),
      sweep: vi.fn(async () => undefined),
      start: vi.fn(),
      stop: vi.fn(async () => { await stopGate; }),
    };
    const app = buildGatewayApp({
      config: resolveGatewayConfig({ baseDir }),
      db,
      clients: new ClientRepository(db),
      credentials: new CredentialService(db, Buffer.alloc(32, 1)),
      targets: new TargetRepository(db),
      grants: new GrantRepository(db),
      extensions: new ExtensionRepository(db),
      runs: new RunRepository(db),
      adminAuth: new AdminAuthService(db, Buffer.alloc(32, 2)),
      retention,
    });
    await app.ready();

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(retention.stop).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    releaseStop();
    await closing;
    expect(closed).toBe(true);
  });
});
