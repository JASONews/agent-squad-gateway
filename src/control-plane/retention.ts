import type { GatewayDb } from './db.js';
import type { ResponseRetentionChain, ResponseSessionRepository } from './response-sessions.js';
import type { RetentionWorkspaceOutcome } from '../provider-runtime/workspaces.js';

const HOUR_MS = 60 * 60 * 1000;
const RUN_RETENTION_MS = 30 * 24 * HOUR_MS;

interface RetentionTimer {
  unref?(): void;
}

export interface RetentionWorkspace {
  cleanupForRetention(paths: string[]): Promise<RetentionWorkspaceOutcome[]>;
}

export interface RetentionResult {
  interruptedRuns: number;
  terminalResponseChains: number;
  deletedRuns: number;
  deletedResponses: number;
  deletedIdempotencyKeys: number;
  deletedAdminSessions: number;
  deletedWorkspaces: number;
}

export interface RetentionLifecycle {
  reconcileStartup(now?: Date): Promise<RetentionResult | void>;
  sweep(now?: Date): Promise<RetentionResult | void>;
  start(): void;
  stop(): void | Promise<void>;
}

export interface RetentionServiceOptions {
  now?: () => number;
  setInterval?: (callback: () => void, intervalMs: number) => RetentionTimer;
  clearInterval?: (timer: RetentionTimer) => void;
  onTimerError?: (error: unknown) => void;
}

export class RetentionService implements RetentionLifecycle {
  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => void, intervalMs: number) => RetentionTimer;
  private readonly clearIntervalFn: (timer: RetentionTimer) => void;
  private readonly onTimerError: (error: unknown) => void;
  private timer: RetentionTimer | undefined;
  private activeSweep: Promise<RetentionResult> | undefined;

  constructor(
    private readonly db: GatewayDb,
    private readonly responses: ResponseSessionRepository,
    private readonly workspaces: RetentionWorkspace,
    options: RetentionServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval
      ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearIntervalFn = options.clearInterval
      ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
    this.onTimerError = options.onTimerError
      ?? ((error) => { console.error('Gateway retention sweep failed', error); });
  }

  async reconcileStartup(now = new Date(this.now())): Promise<RetentionResult> {
    const timestamp = validTimestamp(now);
    const transaction = this.db.raw.transaction(() => {
      const result = emptyResult();
      result.interruptedRuns = this.db.prepare(`
        UPDATE runs
        SET status = 'interrupted', completed_at = ?,
            latency_ms = CASE
              WHEN started_at IS NULL THEN NULL
              ELSE MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
            END
        WHERE status IN ('queued', 'running')
      `).run(timestamp, timestamp).changes;

      result.terminalResponseChains = this.db.prepare<[], { count: number }>(`
        SELECT COUNT(DISTINCT chain_id) AS count
        FROM response_sessions
        WHERE state = 'continuing'
      `).get()?.count ?? 0;
      this.db.prepare(`
        UPDATE response_sessions
        SET state = 'terminal_failure', updated_at = ?
        WHERE chain_id IN (
          SELECT chain_id FROM response_sessions WHERE state = 'continuing'
        )
      `).run(timestamp);
      return result;
    });
    return transaction.immediate();
  }

  sweep(now = new Date(this.now())): Promise<RetentionResult> {
    if (this.activeSweep !== undefined) {
      return Promise.reject(new Error('retention_sweep_in_progress'));
    }
    const operation = this.performSweep(now);
    let tracked!: Promise<RetentionResult>;
    tracked = operation.finally(() => {
      if (this.activeSweep === tracked) this.activeSweep = undefined;
    });
    this.activeSweep = tracked;
    return tracked;
  }

  private async performSweep(now: Date): Promise<RetentionResult> {
    const timestamp = validTimestamp(now);
    const chains = this.responses.findExpiredForRetention(timestamp);
    this.responses.hideForRetention(chains);
    const paths = uniqueWorkspacePaths(chains);
    const outcomes = paths.length === 0
      ? []
      : await this.workspaces.cleanupForRetention(paths);
    const outcomeByPath = new Map(outcomes.map((outcome) => [outcome.path, outcome.status]));
    const eligibleChains = chains.filter((chain) => chain.workspacePaths.every(
      (path) => outcomeByPath.get(path) !== 'retry' && outcomeByPath.has(path),
    ));
    const cutoff = new Date(now.getTime() - RUN_RETENTION_MS).toISOString();

    const transaction = this.db.raw.transaction(() => {
      const result = emptyResult();
      result.deletedResponses = this.responses.unlinkAndDeleteForRetention(
        eligibleChains.map((chain) => chain.chainId),
      );
      result.deletedIdempotencyKeys = this.db.prepare(`
          DELETE FROM idempotency_keys
          WHERE expires_at <= ? AND status != 'active'
        `).run(timestamp).changes;
      result.deletedRuns = this.db.prepare(`
          DELETE FROM runs
          WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
            AND completed_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM idempotency_keys WHERE idempotency_keys.run_id = runs.id
            )
        `).run(cutoff).changes;
      result.deletedAdminSessions = this.db.prepare(
        'DELETE FROM admin_sessions WHERE expires_at <= ?',
      ).run(timestamp).changes;
      result.deletedWorkspaces = outcomes.filter((outcome) => outcome.status === 'removed').length;
      return result;
    });
    const result = transaction.immediate();
    this.responses.releaseRetentionHidden(eligibleChains);
    return result;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => {
      if (this.activeSweep !== undefined) return;
      void this.sweep().catch(this.onTimerError);
    }, HOUR_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
    await this.activeSweep;
  }
}

function emptyResult(): RetentionResult {
  return {
    interruptedRuns: 0,
    terminalResponseChains: 0,
    deletedRuns: 0,
    deletedResponses: 0,
    deletedIdempotencyKeys: 0,
    deletedAdminSessions: 0,
    deletedWorkspaces: 0,
  };
}

function validTimestamp(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error('invalid_retention_time');
  return value.toISOString();
}

function uniqueWorkspacePaths(chains: readonly ResponseRetentionChain[]): string[] {
  return [...new Set(chains.flatMap((chain) => chain.workspacePaths))].sort();
}
