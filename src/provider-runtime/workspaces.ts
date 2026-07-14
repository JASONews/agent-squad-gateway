import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { InvocationTarget } from '../control-plane/types.js';
import { GatewayError } from '../server/errors.js';

const MARKER = '.gateway-workspace';
const OWNER_KEY = '.gateway-owner-key';
const QUARANTINE = '.gateway-quarantine';
const STAGING = '.gateway-staging';
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RECOVERY_ENTRY = /^[a-f0-9]{48}$/;
const OWNER_KEY_BYTES = 32;
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
type WorkspaceKind = 'response' | 'strict' | 'temporary';
type DetachReason = 'cleanup' | 'strict-acquire' | 'strict-release' | 'temporary-acquire' | 'temporary-release';
type QuarantineRemovalReason = DetachReason | 'recovery';
type StagingRemovalReason = 'recovery' | 'transaction-cleanup';
type MarkerOperationPhase = 'temporary-write' | 'temporary-fsync' | 'temporary-rename' | 'directory-commit';

interface FileIdentity {
  dev: number;
  ino: number;
}

interface RecoveryEntry {
  path: string;
  identity: FileIdentity;
}

interface DetachedEntry extends RecoveryEntry {
  destinationParentIdentity: FileIdentity;
}

interface RootState {
  root: string;
  rootIdentity: FileIdentity;
  quarantine: string;
  quarantineIdentity: FileIdentity;
  staging: string;
  stagingIdentity: FileIdentity;
  ownerKey: Buffer;
}

export interface WorkspaceManagerTestHooks {
  beforeAtomicDetach?(event: { path: string; reason: DetachReason }): void;
  beforeMarkerCommit?(event: { markerPath: string; path: string; kind: WorkspaceKind }): void;
  beforeMarkerOperation?(event: {
    markerPath: string;
    path: string;
    kind: WorkspaceKind;
    phase: MarkerOperationPhase;
  }): void;
  beforeDirectoryRollback?(event: { path: string; kind: WorkspaceKind }): void;
  beforeMarkerOpen?(event: { markerPath: string; path: string; kind: WorkspaceKind }): void;
  beforeQuarantineRemove?(event: { path: string; reason: QuarantineRemovalReason }): void;
  beforeStagingRemove?(event: { path: string; reason: StagingRemovalReason }): void;
}

export interface WorkspaceManagerOptions {
  /**
   * Required synchronous view of every currently configured fixed workspace.
   * Production callers must derive the complete list from the current TargetRepository state.
   */
  getFixedWorkspaces(): readonly string[];
  /** Deterministic filesystem-race seams. Production callers must leave this unset. */
  testHooks?: WorkspaceManagerTestHooks;
}

export interface WorkspaceLease {
  path: string;
  release(): Promise<void>;
}

export type RetentionWorkspaceStatus = 'removed' | 'absent' | 'unmanaged' | 'retry';

export interface RetentionWorkspaceOutcome {
  path: string;
  status: RetentionWorkspaceStatus;
}

export class WorkspaceManager {
  private readonly configuredRoot: string;
  private readonly getFixedWorkspaces: () => readonly string[];
  private readonly testHooks: WorkspaceManagerTestHooks;
  private rootPromise: Promise<RootState> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, number>();

  constructor(workspacesDir: string, options: WorkspaceManagerOptions) {
    this.configuredRoot = resolve(workspacesDir);
    this.getFixedWorkspaces = options.getFixedWorkspaces;
    this.testHooks = options.testHooks ?? {};
  }

  acquireChat(target: InvocationTarget, runId: string): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      validateComponent('target', target.id);
      validateComponent('run', runId);
      if (target.fixedWorkspace !== null) return this.fixedLease(target.fixedWorkspace);
      return target.isolationLevel === 'strict'
        ? this.acquireStrict(target)
        : this.acquireTemporary(runId);
    });
  }

  createResponse(target: InvocationTarget, responseId: string): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      validateComponent('target', target.id);
      const id = validateComponent('response', responseId);
      if (target.fixedWorkspace !== null) return this.fixedLease(target.fixedWorkspace);
      const state = await this.root();
      const responses = this.ensureDirectory(state, ['responses']).path;
      const path = join(responses, id);
      const identity = this.managedDirectoryIdentity(path);
      if (identity === undefined) await this.replaceDirectory(state, path, 'response', 'cleanup');
      else this.requireMarker(state, path, 'response');
      return this.persistentLease(path);
    });
  }

  openResponse(path: string): Promise<WorkspaceLease> {
    return this.exclusive(async () => {
      const state = await this.root();
      const canonical = this.validateResponsePath(state, path);
      return this.persistentLease(canonical);
    });
  }

  cleanupExpired(paths: string[]): Promise<void> {
    return this.cleanupForRetention(paths).then(() => undefined);
  }

  cleanupForRetention(paths: string[]): Promise<RetentionWorkspaceOutcome[]> {
    return this.exclusive(async () => {
      const state = await this.root();
      try {
        this.sweepRecovery(state);
      } catch (error) {
        if (error instanceof FixedWorkspaceConfigurationError) throw error;
        return paths.map((path): RetentionWorkspaceOutcome => ({
          path,
          status: this.cleanupCandidate(state, path) === null ? 'unmanaged' : 'retry',
        }));
      }
      const outcomes: RetentionWorkspaceOutcome[] = [];
      for (const path of paths) {
        const candidate = this.cleanupCandidate(state, path);
        if (candidate === null) {
          outcomes.push({ path, status: 'unmanaged' });
          continue;
        }
        if (this.active.has(candidate.path)) {
          outcomes.push({ path, status: 'retry' });
          continue;
        }
        let identity: FileIdentity;
        try {
          identity = this.requireMarker(state, candidate.path, candidate.kind);
        } catch (error) {
          outcomes.push({
            path,
            status: isMissingWorkspacePath(candidate.path, error) ? 'absent' : 'retry',
          });
          continue;
        }
        try {
          this.sweepRecovery(state);
          const detached = this.atomicDetach(state, candidate.path, identity, 'cleanup');
          this.removeQuarantined(state, detached, 'cleanup');
          outcomes.push({ path, status: 'removed' });
        } catch (error) {
          if (error instanceof FixedWorkspaceConfigurationError) throw error;
          outcomes.push({
            path,
            status: isMissingWorkspacePath(candidate.path, error) ? 'absent' : 'retry',
          });
        }
      }
      return outcomes;
    });
  }

  private async acquireStrict(target: InvocationTarget): Promise<WorkspaceLease> {
    const targetId = validateComponent('target', target.id);
    if (!Number.isSafeInteger(target.maxConcurrency) || target.maxConcurrency < 1) {
      throw new Error('invalid target maxConcurrency');
    }

    const state = await this.root();
    for (let index = 0; index < target.maxConcurrency; index += 1) {
      const slots = this.ensureDirectory(state, ['targets', targetId, 'slots']).path;
      const path = join(slots, String(index));
      if (this.active.has(path)) continue;
      const detached = await this.replaceDirectory(state, path, 'strict', 'strict-acquire');
      if (detached !== null) this.removeQuarantined(state, detached, 'strict-acquire');
      this.active.set(path, 1);
      let pendingRelease: RecoveryEntry | null | undefined;
      return this.destructiveLease(path, async () => {
        if (pendingRelease === undefined) {
          pendingRelease = await this.replaceDirectory(state, path, 'strict', 'strict-release');
        }
        if (pendingRelease !== null) this.removeQuarantined(state, pendingRelease, 'strict-release');
        pendingRelease = null;
      });
    }
    throw new GatewayError(429, 'target_busy', `target ${target.id} has no free workspace slots`);
  }

  private async acquireTemporary(runId: string): Promise<WorkspaceLease> {
    const id = validateComponent('run', runId);
    const state = await this.root();
    const temporary = this.ensureDirectory(state, ['temporary']).path;
    const path = join(temporary, id);
    if (this.active.has(path)) {
      throw new GatewayError(429, 'target_busy', `run ${runId} already has a workspace lease`);
    }
    const detached = await this.replaceDirectory(state, path, 'temporary', 'temporary-acquire');
    if (detached !== null) this.removeQuarantined(state, detached, 'temporary-acquire');
    this.active.set(path, 1);
    let pendingRelease: RecoveryEntry | null | undefined;
    return this.destructiveLease(path, async () => {
      if (pendingRelease === undefined) {
        this.sweepRecovery(state);
        pendingRelease = this.removeManagedPath(state, path, 'temporary', 'temporary-release');
      }
      if (pendingRelease !== null) {
        this.removeQuarantined(state, pendingRelease, 'temporary-release');
      }
      pendingRelease = null;
    });
  }

  private async fixedLease(path: string): Promise<WorkspaceLease> {
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error('fixed workspace must be a directory');
    const prospectiveRoot = canonicalizeProspectivePath(this.configuredRoot);
    const configured = this.authoritativeFixedWorkspaces(prospectiveRoot);
    if (!configured.includes(canonical)) throw new Error('fixed workspace is not configured');
    return { path: canonical, release: async () => undefined };
  }

  private destructiveLease(path: string, cleanup: () => Promise<void>): WorkspaceLease {
    let released = false;
    return {
      path,
      release: () => this.exclusive(async () => {
        if (released) return;
        await cleanup();
        this.active.delete(path);
        released = true;
      }),
    };
  }

  private persistentLease(path: string): WorkspaceLease {
    this.active.set(path, (this.active.get(path) ?? 0) + 1);
    let released = false;
    return {
      path,
      release: () => this.exclusive(async () => {
        if (released) return;
        const remaining = (this.active.get(path) ?? 1) - 1;
        if (remaining === 0) this.active.delete(path);
        else this.active.set(path, remaining);
        released = true;
      }),
    };
  }

  private root(): Promise<RootState> {
    if (this.rootPromise === undefined) {
      const pending = Promise.resolve().then(() => this.initializeRoot());
      this.rootPromise = pending;
      void pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  private async initializeRoot(): Promise<RootState> {
    const prospectiveRoot = canonicalizeProspectivePath(this.configuredRoot);
    this.authoritativeFixedWorkspaces(prospectiveRoot);

    mkdirSync(this.configuredRoot, { recursive: true, mode: 0o700 });
    const root = realpathSync(this.configuredRoot);
    this.authoritativeFixedWorkspaces(root);
    chmodSync(root, 0o700);
    const rootIdentity = directoryIdentity(root);
    const ownerKey = loadOrCreateOwnerKey(root);
    const quarantine = join(root, QUARANTINE);
    ensurePrivateDirectory(quarantine);
    const quarantineIdentity = directoryIdentity(quarantine);
    const staging = join(root, STAGING);
    ensurePrivateDirectory(staging);
    const stagingIdentity = directoryIdentity(staging);
    const state = { root, rootIdentity, quarantine, quarantineIdentity, staging, stagingIdentity, ownerKey };
    this.sweepRecovery(state);
    return state;
  }

  private ensureDirectory(
    state: RootState,
    parts: string[],
  ): { path: string; created: boolean; identity: FileIdentity } {
    this.requireRootIdentity(state);
    let current = state.root;
    let finalCreated = false;
    for (let index = 0; index < parts.length; index += 1) {
      const candidate = join(current, parts[index]!);
      let created = false;
      try {
        const entry = lstatSync(candidate);
        if (entry.isSymbolicLink()) throw new Error(`managed workspace contains symbolic link: ${candidate}`);
        if (!entry.isDirectory()) throw new Error(`managed workspace path is not a directory: ${candidate}`);
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
        try {
          mkdirSync(candidate, { mode: 0o700 });
          created = true;
        } catch (mkdirError) {
          if (!isErrorCode(mkdirError, 'EEXIST')) throw mkdirError;
          const winner = lstatSync(candidate);
          if (winner.isSymbolicLink() || !winner.isDirectory()) {
            throw new Error(`unsafe managed workspace path: ${candidate}`);
          }
        }
      }
      const canonical = realpathSync(candidate);
      assertContained(state.root, canonical, false);
      if (canonical !== candidate) throw new Error(`managed workspace path is not canonical: ${candidate}`);
      current = canonical;
      if (index === parts.length - 1) finalCreated = created;
    }
    return { path: current, created: finalCreated, identity: directoryIdentity(current) };
  }

  private async replaceDirectory(
    state: RootState,
    path: string,
    kind: WorkspaceKind,
    reason: DetachReason,
  ): Promise<RecoveryEntry | null> {
    this.sweepRecovery(state);
    const existingIdentity = this.managedDirectoryIdentity(path);
    const expectedIdentity = existingIdentity === undefined ? undefined : this.requireMarker(state, path, kind);
    const staged = join(state.staging, randomBytes(24).toString('hex'));
    mkdirSync(staged, { mode: 0o700 });
    const stagedIdentity = directoryIdentity(staged);
    try {
      this.writeMarker(state, staged, path, kind, stagedIdentity);
      return this.publishStagedDirectory(state, staged, stagedIdentity, path, kind, reason, expectedIdentity);
    } catch (error) {
      try {
        this.removeStaged(state, { path: staged, identity: stagedIdentity }, 'transaction-cleanup');
      } catch (cleanupError) {
        throw combinedError(error, cleanupError, `failed to clean staged workspace for ${path}`);
      }
      throw error;
    }
  }

  private removeManagedPath(
    state: RootState,
    path: string,
    kind: WorkspaceKind,
    reason: DetachReason,
  ): RecoveryEntry | null {
    let identity: FileIdentity;
    try {
      identity = this.requireMarker(state, path, kind);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
    const detached = this.atomicDetach(state, path, identity, reason);
    return detached;
  }

  private removeQuarantined(
    state: RootState,
    entry: RecoveryEntry,
    reason: QuarantineRemovalReason,
  ): void {
    this.testHooks.beforeQuarantineRemove?.({ path: entry.path, reason });
    const fixedWorkspaces = this.canonicalFixedWorkspaceSnapshot();

    this.requireRootIdentity(state);
    this.validateRecoveryEntry(state, state.quarantine, state.quarantineIdentity, entry);
    this.assertFixedWorkspaceSnapshotSafe(state.root, fixedWorkspaces);
    rmSync(entry.path, { recursive: true, force: true });
  }

  private removeStaged(state: RootState, entry: RecoveryEntry, reason: StagingRemovalReason): void {
    this.testHooks.beforeStagingRemove?.({ path: entry.path, reason });
    const fixedWorkspaces = this.canonicalFixedWorkspaceSnapshot();

    this.requireRootIdentity(state);
    this.validateRecoveryEntry(state, state.staging, state.stagingIdentity, entry);
    this.assertFixedWorkspaceSnapshotSafe(state.root, fixedWorkspaces);
    rmSync(entry.path, { recursive: true, force: true });
  }

  private sweepRecovery(state: RootState): void {
    this.sweepDirectory(state, state.quarantine, state.quarantineIdentity, (entry) =>
      this.removeQuarantined(state, entry, 'recovery'));
    this.sweepDirectory(state, state.staging, state.stagingIdentity, (entry) =>
      this.removeStaged(state, entry, 'recovery'));
  }

  private sweepDirectory(
    state: RootState,
    directory: string,
    expectedIdentity: FileIdentity,
    removeEntry: (entry: RecoveryEntry) => void,
  ): void {
    this.validateRecoveryDirectory(state, directory, expectedIdentity);
    const entries = readdirSync(directory).sort();
    for (const name of entries) {
      const path = join(directory, name);
      if (!RECOVERY_ENTRY.test(name)) throw new Error(`unsafe recovery entry: ${path}`);
      removeEntry({ path, identity: identityOf(lstatSync(path)) });
    }
  }

  private atomicDetach(
    state: RootState,
    path: string,
    expectedIdentity: FileIdentity,
    reason: DetachReason,
  ): DetachedEntry {
    this.testHooks.beforeAtomicDetach?.({ path, reason });

    // Node has no dirfd/openat API. Keep the final ancestor checks and rename in
    // one synchronous sequence so no same-process task can interleave a swap.
    this.assertFixedWorkspacesSafe(state);
    this.requireRootIdentity(state);
    const parent = dirname(path);
    const destinationParentIdentity = this.validateManagedDirectory(state, parent);
    this.validateRecoveryDirectory(state, state.quarantine, state.quarantineIdentity);
    if (readdirSync(state.quarantine).length !== 0) throw new Error('pending quarantine cleanup');
    const current = lstatSync(path);
    if (!current.isSymbolicLink()) {
      if (!current.isDirectory() || !sameIdentity(identityOf(current), expectedIdentity)) {
        throw new Error(`managed workspace changed before detach: ${path}`);
      }
    }

    const quarantined = join(state.quarantine, randomBytes(24).toString('hex'));
    renameSync(path, quarantined);
    return { path: quarantined, identity: identityOf(current), destinationParentIdentity };
  }

  private publishStagedDirectory(
    state: RootState,
    staged: string,
    stagedIdentity: FileIdentity,
    path: string,
    kind: WorkspaceKind,
    reason: DetachReason,
    expectedIdentity?: FileIdentity,
  ): RecoveryEntry | null {
    if (expectedIdentity === undefined) {
      this.testHooks.beforeMarkerOperation?.({
        markerPath: join(staged, MARKER),
        path,
        kind,
        phase: 'directory-commit',
      });
      this.assertFixedWorkspacesSafe(state);
      this.validateManagedDirectory(state, dirname(path));
      if (this.managedDirectoryIdentity(path) !== undefined) throw new Error(`managed workspace already exists: ${path}`);
      if (!sameIdentity(this.validateManagedDirectory(state, staged), stagedIdentity)) {
        throw new Error(`staged managed workspace changed before commit: ${path}`);
      }
      renameSync(staged, path);
      return null;
    }

    const detached = this.atomicDetach(state, path, expectedIdentity, reason);
    try {
      this.testHooks.beforeMarkerOperation?.({
        markerPath: join(staged, MARKER),
        path,
        kind,
        phase: 'directory-commit',
      });
      this.assertFixedWorkspacesSafe(state);
      this.validateManagedDirectory(state, dirname(path));
      if (!sameIdentity(this.validateManagedDirectory(state, staged), stagedIdentity)) {
        throw new Error(`staged managed workspace changed before commit: ${path}`);
      }
      renameSync(staged, path);
      return detached;
    } catch (error) {
      try {
        this.testHooks.beforeDirectoryRollback?.({ path, kind });
        const fixedWorkspaces = this.canonicalFixedWorkspaceSnapshot();

        this.requireRootIdentity(state);
        this.validateRecoveryEntry(state, state.quarantine, state.quarantineIdentity, detached);
        const destinationParentIdentity = this.validateManagedDirectory(state, dirname(path));
        if (!sameIdentity(destinationParentIdentity, detached.destinationParentIdentity)) {
          throw new Error(`managed workspace parent changed during rollback: ${path}`);
        }
        if (this.managedDirectoryIdentity(path) !== undefined) {
          throw new Error(`managed workspace occupied during rollback: ${path}`);
        }
        this.assertFixedWorkspaceSnapshotSafe(state.root, fixedWorkspaces);
        renameSync(detached.path, path);
      } catch (rollbackError) {
        throw combinedError(error, rollbackError, `failed to roll back managed workspace ${path}`);
      }
      throw error;
    }
  }

  private managedDirectoryIdentity(path: string): FileIdentity | undefined {
    try {
      const entry = lstatSync(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`unsafe managed workspace: ${path}`);
      if (realpathSync(path) !== path) throw new Error(`managed workspace is not canonical: ${path}`);
      return identityOf(entry);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  private validateRecoveryDirectory(state: RootState, path: string, expectedIdentity: FileIdentity): void {
    const identity = this.validateManagedDirectory(state, path);
    if (!sameIdentity(identity, expectedIdentity)) throw new Error(`unsafe recovery directory: ${path}`);
  }

  private validateRecoveryEntry(
    state: RootState,
    directory: string,
    directoryIdentity: FileIdentity,
    entry: RecoveryEntry,
  ): void {
    this.validateRecoveryDirectory(state, directory, directoryIdentity);
    if (dirname(entry.path) !== directory || !RECOVERY_ENTRY.test(basename(entry.path))) {
      throw new Error(`unsafe recovery entry: ${entry.path}`);
    }
    const current = lstatSync(entry.path);
    if (!sameIdentity(identityOf(current), entry.identity)) {
      throw new Error(`recovery entry changed before removal: ${entry.path}`);
    }
  }

  private validateManagedDirectory(state: RootState, path: string): FileIdentity {
    this.requireRootIdentity(state);
    if (!isAbsolute(path) || path !== resolve(path)) throw new Error(`unsafe managed workspace: ${path}`);
    assertContained(state.root, path, true);
    const relation = relative(state.root, path);
    let current = state.root;
    if (relation !== '') {
      for (const part of relation.split(sep)) {
        current = join(current, part);
        const entry = lstatSync(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(`managed workspace ancestor is unsafe: ${current}`);
        }
        if (realpathSync(current) !== current) {
          throw new Error(`managed workspace ancestor is not canonical: ${current}`);
        }
      }
    }
    return directoryIdentity(path);
  }

  private validateResponsePath(state: RootState, path: string): string {
    if (!isAbsolute(path) || path !== resolve(path)) throw new Error('path is not a canonical managed response');
    const candidate = resolve(path);
    if (!isContained(state.root, candidate, false)) throw new Error('path is not a managed response');
    const parts = relative(state.root, candidate).split(sep);
    if (parts.length !== 2 || parts[0] !== 'responses') throw new Error('path is not a managed response');
    validateComponent('response', parts[1]!);
    try {
      this.requireMarker(state, candidate, 'response');
    } catch {
      throw new Error('path is not a managed response or has an invalid marker');
    }
    return candidate;
  }

  private cleanupCandidate(state: RootState, path: string): { path: string; kind: WorkspaceKind } | null {
    if (!isAbsolute(path) || path !== resolve(path)) return null;
    const candidate = resolve(path);
    if (!isContained(state.root, candidate, false)) return null;
    const parts = relative(state.root, candidate).split(sep);
    try {
      const kind = cleanupKind(parts);
      return kind === null ? null : { path: candidate, kind };
    } catch {
      return null;
    }
  }

  private writeMarker(
    state: RootState,
    directory: string,
    path: string,
    kind: WorkspaceKind,
    expectedIdentity: FileIdentity,
  ): void {
    const identity = this.validateManagedDirectory(state, directory);
    if (!sameIdentity(identity, expectedIdentity)) throw new Error(`managed workspace changed before marking: ${path}`);
    const markerPath = join(directory, MARKER);
    const temporaryPath = join(directory, `.${MARKER}.${randomBytes(24).toString('hex')}.tmp`);
    const marker = expectedMarker(state, path, kind);
    let descriptor: number | undefined;
    let failure: unknown;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        0o600,
      );
      this.testHooks.beforeMarkerOperation?.({ markerPath, path, kind, phase: 'temporary-write' });
      writeFileSync(descriptor, marker);
      this.testHooks.beforeMarkerOperation?.({ markerPath, path, kind, phase: 'temporary-fsync' });
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;

      this.testHooks.beforeMarkerCommit?.({ markerPath, path, kind });
      const currentIdentity = this.validateManagedDirectory(state, directory);
      if (!sameIdentity(currentIdentity, expectedIdentity)) {
        throw new Error(`managed workspace changed before marker commit: ${path}`);
      }
      this.testHooks.beforeMarkerOperation?.({ markerPath, path, kind, phase: 'temporary-rename' });
      renameSync(temporaryPath, markerPath);
      syncDirectory(directory);
    } catch (error) {
      failure = error;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch (closeError) {
          failure = failure === undefined
            ? closeError
            : combinedError(failure, closeError, `failed to close marker temporary file for ${path}`);
        }
      }
      try {
        unlinkSync(temporaryPath);
      } catch (cleanupError) {
        if (!isErrorCode(cleanupError, 'ENOENT')) {
          failure = failure === undefined
            ? cleanupError
            : combinedError(failure, cleanupError, `failed to clean marker temporary file for ${path}`);
        }
      }
    }
    if (failure !== undefined) throw failure;
  }

  private requireMarker(state: RootState, path: string, kind: WorkspaceKind): FileIdentity {
    const identity = this.validateManagedDirectory(state, path);
    const markerPath = join(path, MARKER);
    this.testHooks.beforeMarkerOpen?.({ markerPath, path, kind });
    const currentIdentity = this.validateManagedDirectory(state, path);
    if (!sameIdentity(currentIdentity, identity)) throw new Error(`invalid managed workspace marker: ${path}`);

    let descriptor: number | undefined;
    try {
      descriptor = openSync(markerPath, constants.O_RDONLY | NOFOLLOW);
      const markerStat = fstatSync(descriptor);
      if (!markerStat.isFile() || markerStat.size > 256) throw new Error('invalid marker file');
      const actual = readFileSync(descriptor);
      const expected = expectedMarker(state, path, kind);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('invalid marker contents');
      }
      return identity;
    } catch {
      throw new Error(`invalid managed workspace marker: ${path}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private authoritativeFixedWorkspaces(root: string): string[] {
    const configured = this.canonicalFixedWorkspaceSnapshot();
    this.assertFixedWorkspaceSnapshotSafe(root, configured);
    return configured;
  }

  private canonicalFixedWorkspaceSnapshot(): string[] {
    try {
      const configured = this.getFixedWorkspaces();
      if (!Array.isArray(configured)) throw new Error('fixed workspace provider must return an array');
      return Array.from(configured, (path) => {
        const canonical = realpathSync(path);
        if (!statSync(canonical).isDirectory()) throw new Error('fixed workspace must be a directory');
        return canonical;
      });
    } catch (error) {
      if (error instanceof FixedWorkspaceConfigurationError) throw error;
      throw new FixedWorkspaceConfigurationError('invalid fixed workspace configuration', { cause: error });
    }
  }

  private assertFixedWorkspaceSnapshotSafe(root: string, configured: readonly string[]): void {
    for (const canonical of configured) {
      if (pathsOverlap(root, canonical)) {
        throw new FixedWorkspaceConfigurationError('fixed workspace overlaps managed root');
      }
    }
  }

  private assertFixedWorkspacesSafe(state: RootState): void {
    this.authoritativeFixedWorkspaces(state.root);
  }

  private requireRootIdentity(state: RootState): void {
    const entry = lstatSync(state.root);
    if (entry.isSymbolicLink() || !entry.isDirectory() || !sameIdentity(identityOf(entry), state.rootIdentity)) {
      throw new Error('managed workspace root changed');
    }
    if (realpathSync(state.root) !== state.root) throw new Error('managed workspace root is not canonical');
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class FixedWorkspaceConfigurationError extends Error {
  override readonly name = 'FixedWorkspaceConfigurationError';
}

function combinedError(primary: unknown, cleanup: unknown, message: string): AggregateError {
  return new AggregateError(
    [primary, cleanup],
    `${message}: ${String(primary)}; cleanup: ${String(cleanup)}`,
    { cause: primary },
  );
}

function loadOrCreateOwnerKey(root: string): Buffer {
  const keyPath = join(root, OWNER_KEY);
  const candidatePath = join(root, `.${OWNER_KEY}.${randomBytes(24).toString('hex')}.tmp`);
  const candidateKey = randomBytes(OWNER_KEY_BYTES);
  let descriptor: number | undefined;
  let candidateCreated = false;
  try {
    descriptor = openSync(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    candidateCreated = true;
    writeFileSync(descriptor, candidateKey);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(candidatePath, keyPath);
      syncDirectory(root);
      return candidateKey;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (candidateCreated) {
      try {
        unlinkSync(candidatePath);
      } catch (error) {
        if (!isErrorCode(error, 'ENOENT')) throw error;
      }
    }
  }

  try {
    const entry = lstatSync(keyPath);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('invalid owner key');
    descriptor = openSync(keyPath, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== OWNER_KEY_BYTES) throw new Error('invalid owner key');
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function expectedMarker(state: RootState, path: string, kind: WorkspaceKind): Buffer {
  const relativePath = relative(state.root, path).split(sep).join('/');
  const digest = createHmac('sha256', state.ownerKey)
    .update('gateway-workspace-v1\0')
    .update(kind)
    .update('\0')
    .update(relativePath)
    .digest('hex');
  return Buffer.from(`v1:${digest}\n`, 'utf8');
}

function ensurePrivateDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) throw error;
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`unsafe private directory: ${path}`);
  }
  chmodSync(path, 0o700);
  if (realpathSync(path) !== path) throw new Error(`private directory is not canonical: ${path}`);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    if (!isErrorCode(error, 'EINVAL') && !isErrorCode(error, 'ENOTSUP')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function canonicalizeProspectivePath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync(current), ...missing);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function directoryIdentity(path: string): FileIdentity {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`unsafe managed workspace: ${path}`);
  return identityOf(entry);
}

function identityOf(entry: { dev: number; ino: number }): FileIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateComponent(kind: 'response' | 'run' | 'target', value: string): string {
  if (!COMPONENT.test(value)) throw new Error(`invalid ${kind} id`);
  return value;
}

function cleanupKind(parts: string[]): WorkspaceKind | null {
  if (parts.length === 2 && parts[0] === 'responses') {
    validateComponent('response', parts[1]!);
    return 'response';
  }
  if (parts.length === 2 && parts[0] === 'temporary') {
    validateComponent('run', parts[1]!);
    return 'temporary';
  }
  if (
    parts.length === 4
    && parts[0] === 'targets'
    && parts[2] === 'slots'
    && /^(0|[1-9][0-9]*)$/.test(parts[3]!)
  ) {
    validateComponent('target', parts[1]!);
    return 'strict';
  }
  return null;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isMissingWorkspacePath(path: string, error: unknown): boolean {
  if (!isMissingPath(error)) return false;
  try {
    lstatSync(path);
    return false;
  } catch (pathError) {
    return isMissingPath(pathError);
  }
}

function assertContained(root: string, path: string, allowRoot: boolean): void {
  if (!isContained(root, path, allowRoot)) throw new Error(`workspace path resolves outside managed root: ${path}`);
}

function pathsOverlap(left: string, right: string): boolean {
  return isContained(left, right, true) || isContained(right, left, true);
}

function isContained(root: string, path: string, allowRoot: boolean): boolean {
  const relation = relative(root, path);
  if (relation === '') return allowRoot;
  return !isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`);
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
