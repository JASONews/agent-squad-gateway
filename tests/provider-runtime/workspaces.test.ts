import { afterEach, describe, expect, it } from 'vitest';
import * as syncFs from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { InvocationTarget } from '../../src/control-plane/types.js';
import {
  WorkspaceManager,
  type WorkspaceManagerOptions,
} from '../../src/provider-runtime/workspaces.js';

const testDirs: string[] = [];

type RecoveryTestHooks = NonNullable<WorkspaceManagerOptions['testHooks']> & {
  beforeStagingRemove?(event: { path: string; reason: 'recovery' | 'transaction-cleanup' }): void;
};

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function testDirectory(prefix = 'asq-gw-workspaces-'): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  testDirs.push(dir);
  return dir;
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function expectContained(root: string, path: string): Promise<void> {
  const [canonicalRoot, canonicalPath] = await Promise.all([fs.realpath(root), fs.realpath(path)]);
  const relation = relative(canonicalRoot, canonicalPath);
  expect(isAbsolute(relation) || relation === '..' || relation.startsWith(`..${sep}`)).toBe(false);
}

function workspaceManager(
  root: string,
  options: Omit<WorkspaceManagerOptions, 'getFixedWorkspaces'> & {
    fixedWorkspaces?: readonly string[];
    getFixedWorkspaces?: () => readonly string[];
  } = {},
): WorkspaceManager {
  const fixedWorkspaces = options.fixedWorkspaces ?? [];
  return new WorkspaceManager(root, {
    getFixedWorkspaces: options.getFixedWorkspaces ?? (() => fixedWorkspaces),
    testHooks: options.testHooks,
  });
}

async function quarantineEntries(root: string): Promise<string[]> {
  return fs.readdir(join(root, '.gateway-quarantine'));
}

async function stagingEntries(root: string): Promise<string[]> {
  return fs.readdir(join(root, '.gateway-staging'));
}

function recoveryTestHooks(hooks: RecoveryTestHooks): WorkspaceManagerOptions['testHooks'] {
  return hooks;
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages);
  return [String(error)];
}

async function leaveRecoveryEntry(root: string, kind: 'quarantine' | 'staging'): Promise<string> {
  if (kind === 'quarantine') {
    const manager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: ({ reason }) => {
          if (reason === 'strict-acquire') throw new Error('leave quarantine entry');
        },
      },
    });
    const seed = await manager.acquireChat(target(), 'run-seed');
    await seed.release();
    await fs.writeFile(join(seed.path, 'keep.txt'), 'recovery entry');
    await expect(manager.acquireChat(target(), 'run-failed')).rejects.toThrow('leave quarantine entry');
    return join(await fs.realpath(root), '.gateway-quarantine', (await quarantineEntries(root))[0]!);
  }

  const manager = workspaceManager(root, {
    testHooks: recoveryTestHooks({
      beforeMarkerOperation: ({ phase }) => {
        if (phase === 'directory-commit') throw new Error('leave staging entry');
      },
      beforeStagingRemove: () => {
        throw new Error('preserve staging entry');
      },
    }),
  });
  await expect(manager.createResponse(target(), 'response-failed')).rejects.toThrow(/leave staging entry/);
  const path = join(await fs.realpath(root), '.gateway-staging', (await stagingEntries(root))[0]!);
  await fs.writeFile(join(path, 'keep.txt'), 'recovery entry');
  return path;
}

describe('WorkspaceManager', () => {
  it('creates a private root and leases stable strict slots that reset on acquire and release', async () => {
    const parent = await testDirectory();
    const root = join(parent, 'managed');
    const manager = workspaceManager(root);

    const first = await manager.acquireChat(target(), 'run-1');
    const canonicalRoot = await fs.realpath(root);
    expect(first.path).toBe(join(canonicalRoot, 'targets', 'target-a', 'slots', '0'));
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    await expectContained(root, first.path);
    await fs.writeFile(join(first.path, 'unexpected.txt'), 'discard me');

    await first.release();
    await first.release();

    expect(await fs.readdir(first.path)).toEqual(['.gateway-workspace']);
    const second = await manager.acquireChat(target(), 'run-2');
    expect(second.path).toBe(first.path);
    expect(await fs.readdir(second.path)).toEqual(['.gateway-workspace']);
    await second.release();
  });

  it('leases each strict slot once up to maxConcurrency and recovers after release', async () => {
    const root = await testDirectory();
    const manager = workspaceManager(root);
    const strictTarget = target({ maxConcurrency: 2 });

    const [first, second] = await Promise.all([
      manager.acquireChat(strictTarget, 'run-1'),
      manager.acquireChat(strictTarget, 'run-2'),
    ]);

    expect(new Set([first.path, second.path]).size).toBe(2);
    await expect(manager.acquireChat(strictTarget, 'run-3')).rejects.toMatchObject({ code: 'target_busy' });
    await first.release();
    const replacement = await manager.acquireChat(strictTarget, 'run-3');
    expect(replacement.path).toBe(first.path);
    await Promise.all([second.release(), replacement.release()]);
  });

  it('removes only a symlink when resetting unexpected strict-slot children', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const manager = workspaceManager(root);
    const lease = await manager.acquireChat(target(), 'run-1');
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    await fs.symlink(outside, join(lease.path, 'escape'));

    await lease.release();

    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    await expect(fs.lstat(join(lease.path, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['../escape', '/absolute', 'nested/path', 'nested\\path', '.', '..', 'encoded%2fslash'])(
    'rejects unsafe target id %s',
    async (id) => {
      const manager = workspaceManager(await testDirectory());
      await expect(manager.acquireChat(target({ id }), 'run-1')).rejects.toThrow('invalid target id');
    },
  );

  it('rejects an unsafe run id even when strict isolation does not include it in the path', async () => {
    const manager = workspaceManager(await testDirectory());
    await expect(manager.acquireChat(target(), '../run')).rejects.toThrow('invalid run id');
  });

  it('creates best-effort workspaces per run and removes them idempotently', async () => {
    const root = await testDirectory();
    const manager = workspaceManager(root);
    const lease = await manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'run-a');

    expect(lease.path).toBe(join(await fs.realpath(root), 'temporary', 'run-a'));
    await expectContained(root, lease.path);
    await fs.writeFile(join(lease.path, 'result.txt'), 'ephemeral');
    await lease.release();
    await lease.release();

    await expect(fs.stat(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an already-removed best-effort workspace as a successful release', async () => {
    const manager = workspaceManager(await testDirectory());
    const lease = await manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'run-removed');
    await fs.rm(lease.path, { recursive: true });

    await expect(lease.release()).resolves.toBeUndefined();
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('retries the same quarantined entry after temporary release cleanup fails', async () => {
    let removalAttempts = 0;
    const manager = workspaceManager(await testDirectory(), {
      testHooks: {
        beforeQuarantineRemove: ({ reason }) => {
          if (reason !== 'temporary-release') return;
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error('injected quarantine removal failure');
        },
      },
    });
    const lease = await manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'run-retry');

    await expect(lease.release()).rejects.toThrow('injected quarantine removal failure');
    await expect(fs.lstat(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lease.release()).resolves.toBeUndefined();

    expect(removalAttempts).toBe(2);
  });

  it.each(['../escape', '/absolute', 'nested/path', 'nested\\path', '.', '..', 'encoded%5cslash'])(
    'rejects unsafe run id %s',
    async (runId) => {
      const manager = workspaceManager(await testDirectory());
      await expect(manager.acquireChat(target({ isolationLevel: 'best_effort' }), runId)).rejects.toThrow(
        'invalid run id',
      );
    },
  );

  it('creates stored responses once and opens the same canonical path without deleting it on release', async () => {
    const root = await testDirectory();
    const manager = workspaceManager(root);
    const first = await manager.createResponse(target(), 'response-a');
    await fs.writeFile(join(first.path, 'state.json'), '{}');

    const continuation = await manager.createResponse(target(), 'response-a');
    const opened = await manager.openResponse(first.path);
    expect(continuation.path).toBe(first.path);
    expect(opened.path).toBe(first.path);
    await Promise.all([first.release(), continuation.release(), opened.release()]);

    await expect(fs.readFile(join(first.path, 'state.json'), 'utf8')).resolves.toBe('{}');
  });

  it.each(['../escape', '/absolute', 'nested/path', 'nested\\path', '.', '..', 'encoded%2fslash'])(
    'rejects unsafe response id %s',
    async (responseId) => {
      const manager = workspaceManager(await testDirectory());
      await expect(manager.createResponse(target(), responseId)).rejects.toThrow('invalid response id');
    },
  );

  it('returns a canonical fixed workspace without modifying or deleting it', async () => {
    const root = await testDirectory();
    const fixed = await testDirectory('asq-gw-fixed-');
    await fs.writeFile(join(fixed, 'admin.txt'), 'untouched');
    const manager = workspaceManager(root, { fixedWorkspaces: [fixed] });
    const fixedTarget = target({ fixedWorkspace: join(fixed, '..', basename(fixed)) });

    const chat = await manager.acquireChat(fixedTarget, 'run-1');
    const response = await manager.createResponse(fixedTarget, 'response-a');
    expect(chat.path).toBe(await fs.realpath(fixed));
    expect(response.path).toBe(chat.path);
    await Promise.all([chat.release(), response.release()]);

    expect(await fs.readdir(fixed)).toEqual(['admin.txt']);
    await expect(fs.readFile(join(fixed, 'admin.txt'), 'utf8')).resolves.toBe('untouched');
  });

  it('detaches a final-entry symlink swap on strict release without following it', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeAtomicDetach: ({ path, reason }) => {
          if (reason !== 'strict-release' || swapped) return;
          swapped = true;
          syncFs.renameSync(path, `${path}.original`);
          syncFs.symlinkSync(outside, path);
        },
      },
    });
    const lease = await manager.acquireChat(target(), 'run-1');

    await lease.release();

    expect(swapped).toBe(true);
    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    expect((await fs.lstat(lease.path)).isDirectory()).toBe(true);
    const replacement = await manager.acquireChat(target(), 'run-2');
    await replacement.release();
  });

  it('detaches a final-entry symlink swap on strict reset without following it', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeAtomicDetach: ({ path, reason }) => {
          if (reason !== 'strict-acquire' || swapped) return;
          swapped = true;
          syncFs.renameSync(path, `${path}.original`);
          syncFs.symlinkSync(outside, path);
        },
      },
    });

    const lease = await manager.acquireChat(target(), 'run-reset');

    expect(swapped).toBe(true);
    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    expect((await fs.lstat(lease.path)).isDirectory()).toBe(true);
    await lease.release();
  });

  it('rejects an ancestor symlink swap at the strict release boundary', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.mkdir(join(outside, 'target-a', 'slots', '0'), { recursive: true });
    await fs.writeFile(join(outside, 'target-a', 'slots', '0', 'keep.txt'), 'safe');
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeAtomicDetach: ({ reason }) => {
          if (reason !== 'strict-release' || swapped) return;
          swapped = true;
          syncFs.renameSync(join(root, 'targets'), join(root, 'targets-original'));
          syncFs.symlinkSync(outside, join(root, 'targets'));
        },
      },
    });
    const lease = await manager.acquireChat(target(), 'run-1');

    await expect(lease.release()).rejects.toThrow(/symbolic link|canonical|unsafe/);

    expect(swapped).toBe(true);
    await expect(fs.readFile(join(outside, 'target-a', 'slots', '0', 'keep.txt'), 'utf8')).resolves.toBe('safe');
  });

  it('rejects managed ancestors that are symlinks escaping the root', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.symlink(outside, join(root, 'targets'));
    const manager = workspaceManager(root);

    await expect(manager.acquireChat(target(), 'run-1')).rejects.toThrow(/symbolic link|outside/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('validates openResponse paths as direct managed response directories', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const manager = workspaceManager(root);
    const response = await manager.createResponse(target(), 'response-a');
    await fs.symlink(outside, join(root, 'responses', 'escape'));

    await expect(manager.openResponse(outside)).rejects.toThrow(/managed response|outside managed root/);
    await expect(manager.openResponse(root)).rejects.toThrow(/managed response|outside managed root/);
    await expect(manager.openResponse(join(root, 'responses', 'escape'))).rejects.toThrow(
      /managed response|outside|symbolic link/,
    );
    await expect(manager.openResponse(join(response.path, 'nested'))).rejects.toThrow(/managed response/);
  });

  it('cleanupExpired deletes only marked, inactive, canonical managed workspaces', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const fixed = await testDirectory('asq-gw-fixed-');
    const manager = workspaceManager(root);
    const response = await manager.createResponse(target(), 'expired-response');
    const active = await manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'active-run');
    const stale = await manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'stale-run');
    await stale.release();
    const unmarked = join(root, 'responses', 'unmarked');
    await fs.mkdir(unmarked);
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    await fs.symlink(outside, join(response.path, 'outward-link'));
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    await response.release();

    await manager.cleanupExpired([response.path, active.path, unmarked, outside, fixed, root]);

    await expect(fs.stat(response.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(active.path)).resolves.toBeDefined();
    await expect(fs.stat(unmarked)).resolves.toBeDefined();
    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
    await expect(fs.stat(root)).resolves.toBeDefined();
    await active.release();
  });

  it('cleanupExpired never follows a managed-looking symlink outside the root', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const manager = workspaceManager(root);
    await manager.createResponse(target(), 'seed');
    await fs.writeFile(join(outside, '.gateway-workspace'), 'response\n');
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    const escape = join(root, 'responses', 'escape');
    await fs.symlink(outside, escape);

    await manager.cleanupExpired([escape]);

    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    await expect(fs.lstat(escape)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
  });

  it('atomically detaches a cleanup final-entry symlink swap without following it', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.writeFile(join(outside, 'keep.txt'), 'safe');
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeAtomicDetach: ({ path, reason }) => {
          if (reason !== 'cleanup' || swapped) return;
          swapped = true;
          syncFs.renameSync(path, `${path}.original`);
          syncFs.symlinkSync(outside, path);
        },
      },
    });
    const response = await manager.createResponse(target(), 'expired-response');
    await response.release();

    await manager.cleanupExpired([response.path]);

    expect(swapped).toBe(true);
    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    await expect(fs.lstat(response.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an ancestor symlink swap at the cleanup boundary', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.mkdir(join(outside, 'expired-response'));
    await fs.writeFile(join(outside, 'expired-response', 'keep.txt'), 'safe');
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeAtomicDetach: ({ reason }) => {
          if (reason !== 'cleanup' || swapped) return;
          swapped = true;
          syncFs.renameSync(join(root, 'responses'), join(root, 'responses-original'));
          syncFs.symlinkSync(outside, join(root, 'responses'));
        },
      },
    });
    const response = await manager.createResponse(target(), 'expired-response');
    await response.release();

    await manager.cleanupExpired([response.path]);

    expect(swapped).toBe(true);
    await expect(fs.readFile(join(outside, 'expired-response', 'keep.txt'), 'utf8')).resolves.toBe('safe');
  });

  it('rejects managed fixed workspaces before strict reset and preserves nested content', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const slot = await seedManager.acquireChat(target(), 'run-seed');
    await slot.release();
    const fixed = join(slot.path, 'admin-fixed');
    await fs.mkdir(fixed);
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    const manager = workspaceManager(root, { fixedWorkspaces: [fixed] });

    await expect(manager.acquireChat(target(), 'run-reset')).rejects.toThrow(/fixed workspace.*managed root/i);

    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
  });

  it('rejects a fixed workspace that is an ancestor of the managed root before initialization', async () => {
    const fixed = await testDirectory('asq-gw-fixed-');
    const root = join(fixed, 'managed');
    await fs.mkdir(root);
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    const manager = workspaceManager(root, { fixedWorkspaces: [fixed] });

    await expect(manager.createResponse(target(), 'response-a')).rejects.toThrow(/fixed workspace.*managed root/i);

    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects overlapping fixed configuration before temporary release or pre-lease cleanup', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const temporary = await seedManager.acquireChat(target({ isolationLevel: 'best_effort' }), 'fixed-run');
    const fixed = join(temporary.path, 'admin-fixed');
    await fs.mkdir(fixed);
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    const manager = workspaceManager(root, { fixedWorkspaces: [fixed] });

    await expect(manager.cleanupExpired([temporary.path])).rejects.toThrow(/fixed workspace.*managed root/i);
    await expect(manager.acquireChat(target({ isolationLevel: 'best_effort' }), 'fixed-run')).rejects.toThrow(
      /fixed workspace.*managed root/i,
    );

    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
  });

  it('rejects target fixed workspaces overlapping the root while external fixed leases remain no-ops', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-fixed-');
    const fixedWorkspaces = [outside];
    const manager = workspaceManager(root, { getFixedWorkspaces: () => fixedWorkspaces });
    const response = await manager.createResponse(target(), 'response-a');
    const nested = join(response.path, 'fixed');
    await fs.mkdir(nested);
    await fs.writeFile(join(nested, 'keep.txt'), 'fixed');
    fixedWorkspaces.push(nested);

    await expect(manager.acquireChat(target({ fixedWorkspace: nested }), 'run-fixed')).rejects.toThrow(
      /fixed workspace.*managed root/i,
    );
    fixedWorkspaces.pop();
    const external = await manager.acquireChat(target({ fixedWorkspace: outside }), 'run-external');
    await external.release();

    await expect(fs.readFile(join(nested, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
    expect(external.path).toBe(await fs.realpath(outside));
  });

  it('re-reads fixed workspaces after initialization and rejects overlap at the final detach boundary', async () => {
    const root = await testDirectory();
    const fixedWorkspaces: string[] = [];
    let protectOnDetach = false;
    const manager = workspaceManager(root, {
      getFixedWorkspaces: () => fixedWorkspaces,
      testHooks: {
        beforeAtomicDetach: ({ path, reason }) => {
          if (reason !== 'strict-acquire' || !protectOnDetach) return;
          const fixed = join(path, 'new-fixed');
          syncFs.mkdirSync(fixed);
          syncFs.writeFileSync(join(fixed, 'keep.txt'), 'fixed');
          fixedWorkspaces.push(fixed);
        },
      },
    });
    const seed = await manager.acquireChat(target(), 'run-seed');
    await seed.release();
    protectOnDetach = true;

    await expect(manager.acquireChat(target(), 'run-reset')).rejects.toThrow(/fixed workspace.*managed root/i);

    await expect(fs.readFile(join(seed.path, 'new-fixed', 'keep.txt'), 'utf8')).resolves.toBe('fixed');
    expect(await quarantineEntries(root)).toEqual([]);
  });

  it('rejects newly configured overlap before cleanup and before the first fixed lease', async () => {
    const root = await testDirectory();
    const fixedWorkspaces: string[] = [];
    const manager = workspaceManager(root, { getFixedWorkspaces: () => fixedWorkspaces });
    const response = await manager.createResponse(target(), 'response-a');
    await response.release();
    const fixed = join(response.path, 'new-fixed');
    await fs.mkdir(fixed);
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    fixedWorkspaces.push(fixed);

    await expect(manager.cleanupExpired([response.path])).rejects.toThrow(/fixed workspace.*managed root/i);
    await expect(manager.acquireChat(target({ fixedWorkspace: fixed }), 'run-fixed')).rejects.toThrow(
      /fixed workspace.*managed root/i,
    );

    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
    expect(await quarantineEntries(root)).toEqual([]);
  });

  it('rejects a target fixed workspace absent from the authoritative provider', async () => {
    const root = await testDirectory();
    const fixed = await testDirectory('asq-gw-fixed-');
    await fs.writeFile(join(fixed, 'keep.txt'), 'fixed');
    const manager = workspaceManager(root, { getFixedWorkspaces: () => [] });
    const fixedTarget = target({ fixedWorkspace: fixed });

    await expect(manager.acquireChat(fixedTarget, 'run-fixed')).rejects.toThrow(/not configured/i);
    await expect(manager.createResponse(fixedTarget, 'response-fixed')).rejects.toThrow(/not configured/i);

    await expect(fs.readFile(join(fixed, 'keep.txt'), 'utf8')).resolves.toBe('fixed');
  });

  it('sweeps crash-leftover quarantine entries before a restarted manager does normal work', async () => {
    const root = await testDirectory();
    let failCleanup = true;
    const firstManager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: ({ reason }) => {
          if (reason === 'strict-acquire' && failCleanup) throw new Error('injected acquire cleanup failure');
        },
      },
    });
    const seed = await firstManager.acquireChat(target(), 'run-seed');
    await seed.release();

    await expect(firstManager.acquireChat(target(), 'run-failed')).rejects.toThrow('injected acquire cleanup failure');
    expect(await quarantineEntries(root)).toHaveLength(1);
    failCleanup = false;

    const restartedManager = workspaceManager(root);
    const response = await restartedManager.createResponse(target(), 'response-after-restart');

    expect(await quarantineEntries(root)).toEqual([]);
    await response.release();
  });

  it('sweeps a real crash-leftover staging entry before a restarted manager does normal work', async () => {
    const root = await testDirectory();
    await leaveRecoveryEntry(root, 'staging');
    expect(await stagingEntries(root)).toHaveLength(1);

    const restartedManager = workspaceManager(root);
    const response = await restartedManager.createResponse(target(), 'response-after-restart');

    expect(await stagingEntries(root)).toEqual([]);
    expect(await quarantineEntries(root)).toEqual([]);
    await response.release();
  });

  it('fails closed without creating another staging or quarantine entry when staging removal remains unavailable', async () => {
    const root = await testDirectory();
    const manager = workspaceManager(root, {
      testHooks: recoveryTestHooks({
        beforeMarkerOperation: ({ phase }) => {
          if (phase === 'directory-commit') throw new Error('persistent commit failure');
        },
        beforeStagingRemove: () => {
          throw new Error('persistent staging failure');
        },
      }),
    });

    await expect(manager.createResponse(target(), 'response-first')).rejects.toThrow(/persistent commit failure/);
    expect(await stagingEntries(root)).toHaveLength(1);
    expect(await quarantineEntries(root)).toEqual([]);

    await expect(manager.createResponse(target(), 'response-second')).rejects.toThrow('persistent staging failure');

    expect(await stagingEntries(root)).toHaveLength(1);
    expect(await quarantineEntries(root)).toEqual([]);
  });

  it.each(['quarantine', 'staging'] as const)(
    'rejects a %s recovery-parent symlink swap without deleting through it',
    async (kind) => {
      const root = await testDirectory();
      const outside = await testDirectory('asq-gw-outside-');
      const leftover = await leaveRecoveryEntry(root, kind);
      const recoveryParent = dirname(leftover);
      const originalParent = `${recoveryParent}.original`;
      const externalEntry = join(outside, basename(leftover));
      await fs.mkdir(externalEntry);
      await fs.writeFile(join(externalEntry, 'keep.txt'), 'external sentinel');
      let swapped = false;
      const swapParent = ({ path }: { path: string }) => {
        if (swapped || path !== leftover) return;
        swapped = true;
        syncFs.renameSync(recoveryParent, originalParent);
        syncFs.symlinkSync(outside, recoveryParent);
      };
      const manager = workspaceManager(root, {
        testHooks: recoveryTestHooks({
          beforeQuarantineRemove: kind === 'quarantine' ? swapParent : undefined,
          beforeStagingRemove: kind === 'staging' ? swapParent : undefined,
        }),
      });

      const failure = await manager.createResponse(target(), 'response-after-swap').catch((error: unknown) => error);
      if (swapped) {
        syncFs.unlinkSync(recoveryParent);
        syncFs.renameSync(originalParent, recoveryParent);
      }

      expect(failure).toBeInstanceOf(Error);
      expect(swapped).toBe(true);
      await expect(fs.readFile(join(externalEntry, 'keep.txt'), 'utf8')).resolves.toBe('external sentinel');
      await expect(fs.readFile(join(leftover, 'keep.txt'), 'utf8')).resolves.toBe('recovery entry');
    },
  );

  it.each(['quarantine', 'staging'] as const)(
    'leaves a %s recovery entry unchanged when the authoritative callback throws',
    async (kind) => {
      const root = await testDirectory();
      const leftover = await leaveRecoveryEntry(root, kind);
      let inRemoval = false;
      let throwAuthority = true;
      const markRemoval = ({ path }: { path: string }) => {
        if (path === leftover) inRemoval = true;
      };
      const manager = workspaceManager(root, {
        getFixedWorkspaces: () => {
          if (inRemoval && throwAuthority) throw new Error('injected recovery authority failure');
          return [];
        },
        testHooks: recoveryTestHooks({
          beforeQuarantineRemove: kind === 'quarantine' ? markRemoval : undefined,
          beforeStagingRemove: kind === 'staging' ? markRemoval : undefined,
        }),
      });

      await expect(manager.createResponse(target(), 'response-authority-failed')).rejects.toThrow(
        'invalid fixed workspace configuration',
      );

      await expect(fs.readFile(join(leftover, 'keep.txt'), 'utf8')).resolves.toBe('recovery entry');
      expect(kind === 'quarantine' ? await quarantineEntries(root) : await stagingEntries(root)).toEqual([
        basename(leftover),
      ]);

      throwAuthority = false;
      const recovered = await manager.createResponse(target(), 'response-authority-restored');
      expect(await quarantineEntries(root)).toEqual([]);
      expect(await stagingEntries(root)).toEqual([]);
      await recovered.release();
    },
  );

  it.each([
    ['strict', target(), 'run-strict', 'strict-acquire'],
    ['temporary', target({ isolationLevel: 'best_effort' }), 'run-temporary', 'temporary-acquire'],
  ] as const)('retries %s acquire cleanup before another reset', async (_kind, invocationTarget, runId, reason) => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(invocationTarget, runId);
    let removalAttempts = 0;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: ({ reason: actualReason }) => {
          if (actualReason !== reason) return;
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error('injected acquire cleanup failure');
        },
      },
    });

    await expect(manager.acquireChat(invocationTarget, runId)).rejects.toThrow('injected acquire cleanup failure');
    expect(await quarantineEntries(root)).toHaveLength(1);
    const lease = await manager.acquireChat(invocationTarget, runId);

    expect(await quarantineEntries(root)).toEqual([]);
    expect(removalAttempts).toBe(2);
    await lease.release();
    if (_kind === 'strict') await seed.release();
  });

  it('retries strict release quarantine cleanup on the same lease', async () => {
    const root = await testDirectory();
    let removalAttempts = 0;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: ({ reason }) => {
          if (reason !== 'strict-release') return;
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error('injected strict release cleanup failure');
        },
      },
    });
    const lease = await manager.acquireChat(target(), 'run-release');

    await expect(lease.release()).rejects.toThrow('injected strict release cleanup failure');
    expect(await quarantineEntries(root)).toHaveLength(1);
    await expect(lease.release()).resolves.toBeUndefined();

    expect(await quarantineEntries(root)).toEqual([]);
    expect(removalAttempts).toBe(2);
  });

  it('retries expiration quarantine cleanup even after the original path is gone', async () => {
    const root = await testDirectory();
    let removalAttempts = 0;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: ({ reason }) => {
          if (reason !== 'cleanup' && reason !== 'recovery') return;
          removalAttempts += 1;
          if (removalAttempts === 1) throw new Error('injected expiration cleanup failure');
        },
      },
    });
    const response = await manager.createResponse(target(), 'expired-response');
    await response.release();

    await manager.cleanupExpired([response.path]);
    await expect(fs.lstat(response.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await quarantineEntries(root)).toHaveLength(1);
    await manager.cleanupExpired([response.path]);

    expect(await quarantineEntries(root)).toEqual([]);
    expect(removalAttempts).toBe(2);
  });

  it('fails closed without growing quarantine when cleanup remains unavailable', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    const manager = workspaceManager(root, {
      testHooks: {
        beforeQuarantineRemove: () => {
          throw new Error('persistent quarantine failure');
        },
      },
    });

    await expect(manager.acquireChat(target(), 'run-first')).rejects.toThrow('persistent quarantine failure');
    expect(await quarantineEntries(root)).toHaveLength(1);
    await expect(manager.acquireChat(target(), 'run-second')).rejects.toThrow('persistent quarantine failure');

    expect(await quarantineEntries(root)).toHaveLength(1);
  });

  it.each(['temporary-write', 'temporary-fsync', 'temporary-rename', 'directory-commit'] as const)(
    'recovers response creation after marker %s failure',
    async (phase) => {
      const root = await testDirectory();
      const outside = await testDirectory('asq-gw-outside-');
      await fs.writeFile(join(outside, 'keep.txt'), 'safe');
      let fail = true;
      const manager = workspaceManager(root, {
        testHooks: {
          beforeMarkerOperation: ({ phase: actualPhase }) => {
            if (fail && actualPhase === phase) throw new Error(`injected marker ${phase} failure`);
          },
        },
      });

      await expect(manager.createResponse(target(), 'response-retry')).rejects.toThrow(
        `injected marker ${phase} failure`,
      );
      await expect(fs.lstat(join(root, 'responses', 'response-retry'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await stagingEntries(root)).toEqual([]);
      fail = false;

      const response = await manager.createResponse(target(), 'response-retry');
      const reopened = await manager.openResponse(response.path);
      await Promise.all([response.release(), reopened.release()]);
      await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('safe');
    },
  );

  it.each(['temporary-write', 'temporary-fsync', 'temporary-rename', 'directory-commit'] as const)(
    'recovers strict slot creation after marker %s failure',
    async (phase) => {
      const root = await testDirectory();
      let fail = true;
      const manager = workspaceManager(root, {
        testHooks: {
          beforeMarkerOperation: ({ phase: actualPhase }) => {
            if (fail && actualPhase === phase) throw new Error(`injected marker ${phase} failure`);
          },
        },
      });

      await expect(manager.acquireChat(target(), 'run-failed')).rejects.toThrow(
        `injected marker ${phase} failure`,
      );
      expect(await stagingEntries(root)).toEqual([]);
      fail = false;

      const lease = await manager.acquireChat(target(), 'run-retry');
      expect(await fs.readdir(lease.path)).toEqual(['.gateway-workspace']);
      await lease.release();
    },
  );

  it('rolls back an existing strict slot when marked-directory commit fails', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    await fs.writeFile(join(seed.path, 'owned.txt'), 'restore me');
    let fail = true;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeMarkerOperation: ({ phase }) => {
          if (fail && phase === 'directory-commit') throw new Error('injected directory commit failure');
        },
      },
    });

    await expect(manager.acquireChat(target(), 'run-failed')).rejects.toThrow('injected directory commit failure');
    await expect(fs.readFile(join(seed.path, 'owned.txt'), 'utf8')).resolves.toBe('restore me');
    expect(await quarantineEntries(root)).toEqual([]);
    expect(await stagingEntries(root)).toEqual([]);
    fail = false;

    const lease = await manager.acquireChat(target(), 'run-retry');
    await expect(fs.lstat(join(lease.path, 'owned.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.release();
  });

  it('does not roll back over a newly fixed detached path and recovers after authority is restored', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    await fs.writeFile(join(seed.path, 'owned.txt'), 'detached content');
    const fixedWorkspaces: string[] = [];
    let failCommit = true;
    let protectedDetachedPath: string | undefined;
    const manager = workspaceManager(root, {
      getFixedWorkspaces: () => fixedWorkspaces,
      testHooks: {
        beforeMarkerOperation: ({ phase }) => {
          if (failCommit && phase === 'directory-commit') throw new Error('initiating commit failure');
        },
        beforeDirectoryRollback: () => {
          const entry = syncFs.readdirSync(join(root, '.gateway-quarantine'))[0]!;
          protectedDetachedPath = join(root, '.gateway-quarantine', entry, 'new-fixed');
          syncFs.mkdirSync(protectedDetachedPath);
          syncFs.writeFileSync(join(protectedDetachedPath, 'keep.txt'), 'fixed sentinel');
          fixedWorkspaces.push(protectedDetachedPath);
        },
      },
    });

    const failure = await manager.acquireChat(target(), 'run-failed').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      'Error: initiating commit failure',
      'FixedWorkspaceConfigurationError: fixed workspace overlaps managed root',
    ]));
    await expect(fs.lstat(seed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(join(dirname(protectedDetachedPath!), 'owned.txt'), 'utf8')).resolves.toBe(
      'detached content',
    );
    await expect(fs.readFile(join(protectedDetachedPath!, 'keep.txt'), 'utf8')).resolves.toBe('fixed sentinel');

    fixedWorkspaces.length = 0;
    failCommit = false;
    const recovered = await manager.acquireChat(target(), 'run-recovered');
    expect(await quarantineEntries(root)).toEqual([]);
    expect(await stagingEntries(root)).toEqual([]);
    await recovered.release();
  });

  it('does not roll back when the authoritative callback throws and later recovers the detached entry', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    await fs.writeFile(join(seed.path, 'owned.txt'), 'detached content');
    let failCommit = true;
    let throwDuringRollback = false;
    const manager = workspaceManager(root, {
      getFixedWorkspaces: () => {
        if (throwDuringRollback) {
          throwDuringRollback = false;
          throw new Error('rollback authority failure');
        }
        return [];
      },
      testHooks: {
        beforeMarkerOperation: ({ phase }) => {
          if (failCommit && phase === 'directory-commit') throw new Error('initiating commit failure');
        },
        beforeDirectoryRollback: () => {
          throwDuringRollback = true;
        },
      },
    });

    const failure = await manager.acquireChat(target(), 'run-failed').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toEqual([
      'Error: initiating commit failure',
      'FixedWorkspaceConfigurationError: invalid fixed workspace configuration',
    ]);
    await expect(fs.lstat(seed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const detached = join(root, '.gateway-quarantine', (await quarantineEntries(root))[0]!);
    await expect(fs.readFile(join(detached, 'owned.txt'), 'utf8')).resolves.toBe('detached content');
    expect(await stagingEntries(root)).toEqual([]);

    failCommit = false;
    const recovered = await manager.acquireChat(target(), 'run-recovered');
    expect(await quarantineEntries(root)).toEqual([]);
    await recovered.release();
  });

  it('rejects a rollback destination-parent symlink swap without mutating the external directory', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    await fs.writeFile(join(outside, 'keep.txt'), 'external sentinel');
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    await fs.writeFile(join(seed.path, 'owned.txt'), 'detached content');
    const destinationParent = dirname(seed.path);
    const originalParent = `${destinationParent}.original`;
    let failCommit = true;
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeMarkerOperation: ({ phase }) => {
          if (failCommit && phase === 'directory-commit') throw new Error('initiating commit failure');
        },
        beforeDirectoryRollback: () => {
          if (swapped) return;
          swapped = true;
          syncFs.renameSync(destinationParent, originalParent);
          syncFs.symlinkSync(outside, destinationParent);
        },
      },
    });

    const failure = await manager.acquireChat(target(), 'run-failed').catch((error: unknown) => error);
    if (swapped) {
      syncFs.unlinkSync(destinationParent);
      syncFs.renameSync(originalParent, destinationParent);
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(errorMessages(failure)).toEqual(expect.arrayContaining([
      'Error: initiating commit failure',
    ]));
    expect(errorMessages(failure).some((message) => /symbolic link|unsafe|changed/.test(message))).toBe(true);
    expect(await fs.readdir(outside)).toEqual(['keep.txt']);
    await expect(fs.readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('external sentinel');
    await expect(fs.lstat(seed.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const detached = join(root, '.gateway-quarantine', (await quarantineEntries(root))[0]!);
    await expect(fs.readFile(join(detached, 'owned.txt'), 'utf8')).resolves.toBe('detached content');

    failCommit = false;
    const recovered = await manager.acquireChat(target(), 'run-recovered');
    expect(await quarantineEntries(root)).toEqual([]);
    await recovered.release();
  });

  it('preserves marker commit and rollback failure context', async () => {
    const root = await testDirectory();
    const seedManager = workspaceManager(root);
    const seed = await seedManager.acquireChat(target(), 'run-seed');
    await seed.release();
    let failCommit = true;
    let failRollback = true;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeMarkerOperation: ({ phase }) => {
          if (failCommit && phase === 'directory-commit') throw new Error('initiating commit failure');
        },
        beforeDirectoryRollback: () => {
          if (failRollback) throw new Error('rollback cleanup failure');
        },
      },
    });

    const failure = await manager.acquireChat(target(), 'run-failed').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      'Error: initiating commit failure',
      'Error: rollback cleanup failure',
    ]);
    failCommit = false;
    failRollback = false;

    const recovered = await manager.acquireChat(target(), 'run-recovered');
    expect(await quarantineEntries(root)).toEqual([]);
    expect(await stagingEntries(root)).toEqual([]);
    await recovered.release();
  });

  it('creates and reuses a private ownership key and non-static path-bound markers', async () => {
    const root = await testDirectory();
    const firstManager = workspaceManager(root);
    const response = await firstManager.createResponse(target(), 'response-a');
    await response.release();
    const keyPath = join(root, '.gateway-owner-key');
    const marker = await fs.readFile(join(response.path, '.gateway-workspace'), 'utf8');

    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(keyPath)).byteLength).toBe(32);
    expect(marker).not.toBe('response\n');
    const secondManager = workspaceManager(root);
    const reopened = await secondManager.openResponse(response.path);
    await reopened.release();
  });

  it('rejects an owner-key symlink without modifying its target', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const sentinel = join(outside, 'owner-key-target');
    await fs.writeFile(sentinel, Buffer.alloc(32, 7));
    await fs.symlink(sentinel, join(root, '.gateway-owner-key'));
    const manager = workspaceManager(root);

    await expect(manager.createResponse(target(), 'response-a')).rejects.toThrow(/owner key|ELOOP|symbolic link/i);

    expect(await fs.readFile(sentinel)).toEqual(Buffer.alloc(32, 7));
  });

  it('rejects static and relocated ownership markers during cleanup', async () => {
    const root = await testDirectory();
    const manager = workspaceManager(root);
    const owned = await manager.createResponse(target(), 'owned');
    await owned.release();
    const responses = dirname(owned.path);
    const staticSpoof = join(responses, 'static-spoof');
    const relocated = join(responses, 'relocated');
    await fs.mkdir(staticSpoof);
    await fs.writeFile(join(staticSpoof, '.gateway-workspace'), 'response\n');
    await fs.mkdir(relocated);
    await fs.copyFile(join(owned.path, '.gateway-workspace'), join(relocated, '.gateway-workspace'));

    await expect(manager.createResponse(target(), 'static-spoof')).rejects.toThrow(/marker/i);
    await expect(manager.createResponse(target(), 'relocated')).rejects.toThrow(/marker/i);
    await manager.cleanupExpired([staticSpoof, relocated]);

    await expect(fs.stat(staticSpoof)).resolves.toBeDefined();
    await expect(fs.stat(relocated)).resolves.toBeDefined();
  });

  it('atomically replaces a marker symlink without modifying its target', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const sentinel = join(outside, 'marker-target');
    await fs.writeFile(sentinel, 'safe');
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeMarkerCommit: ({ markerPath }) => {
          if (swapped) return;
          swapped = true;
          syncFs.symlinkSync(sentinel, markerPath);
        },
      },
    });

    const response = await manager.createResponse(target(), 'response-a');

    expect(swapped).toBe(true);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('safe');
    expect((await fs.lstat(join(response.path, '.gateway-workspace'))).isFile()).toBe(true);
    await response.release();
  });

  it('does not follow a marker symlink swapped at the ownership-read boundary', async () => {
    const root = await testDirectory();
    const outside = await testDirectory('asq-gw-outside-');
    const seedManager = workspaceManager(root);
    const response = await seedManager.createResponse(target(), 'response-a');
    await response.release();
    const markerPath = join(response.path, '.gateway-workspace');
    const sentinel = join(outside, 'marker-target');
    await fs.writeFile(sentinel, await fs.readFile(markerPath));
    let swapped = false;
    const manager = workspaceManager(root, {
      testHooks: {
        beforeMarkerOpen: ({ markerPath: candidate }) => {
          if (candidate !== markerPath || swapped) return;
          swapped = true;
          syncFs.renameSync(candidate, `${candidate}.original`);
          syncFs.symlinkSync(sentinel, candidate);
        },
      },
    });

    await expect(manager.openResponse(response.path)).rejects.toThrow(/marker|managed response/);

    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe(await fs.readFile(`${markerPath}.original`, 'utf8'));
  });
});
