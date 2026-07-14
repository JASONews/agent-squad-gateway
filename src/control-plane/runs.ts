import { randomUUID } from 'node:crypto';
import type { GatewayDb } from './db.js';
import type { CreateRunInput, RunRecord, RunStatus } from './types.js';

interface RunRow {
  id: string;
  client_id: string | null;
  extension_id: string;
  target_id: string;
  endpoint: string;
  status: RunStatus;
  response_id: string | null;
  native_session_id: string | null;
  error_code: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  latency_ms: number | null;
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    extensionId: row.extension_id,
    targetId: row.target_id,
    endpoint: row.endpoint,
    status: row.status,
    responseId: row.response_id,
    nativeSessionId: row.native_session_id,
    errorCode: row.error_code,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    latencyMs: row.latency_ms,
  };
}

export class RunRepository {
  constructor(private readonly db: GatewayDb) {}

  create(input: CreateRunInput, id = reserveRunId()): RunRecord {
    if (typeof input.extensionId !== 'string' || input.extensionId.trim().length === 0) {
      throw new Error('invalid_run_extension');
    }
    if (typeof input.targetId !== 'string' || input.targetId.trim().length === 0) {
      throw new Error('invalid_run_target');
    }
    if (typeof input.endpoint !== 'string' || input.endpoint.trim().length === 0) {
      throw new Error('invalid_run_endpoint');
    }

    const run: RunRecord = {
      id,
      clientId: input.clientId ?? null,
      extensionId: input.extensionId,
      targetId: input.targetId,
      endpoint: input.endpoint,
      status: 'queued',
      responseId: input.responseId ?? null,
      nativeSessionId: null,
      errorCode: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      latencyMs: null,
    };
    this.db.prepare(`
      INSERT INTO runs (
        id, client_id, extension_id, target_id, endpoint, status, response_id,
        queued_at, started_at, completed_at, latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.clientId,
      run.extensionId,
      run.targetId,
      run.endpoint,
      run.status,
      run.responseId,
      run.queuedAt,
      run.startedAt,
      run.completedAt,
      run.latencyMs,
    );
    return run;
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare<[string], RunRow>(`
      SELECT
        id, client_id, extension_id, target_id, endpoint, status, response_id,
        native_session_id, error_code, queued_at, started_at, completed_at, latency_ms
      FROM runs WHERE id = ?
    `).get(id);
    return row === undefined ? undefined : toRunRecord(row);
  }

  markStarted(id: string, nativeSessionId?: string): void {
    const result = this.db.prepare(`
      UPDATE runs
      SET status = 'running', started_at = ?, native_session_id = COALESCE(?, native_session_id)
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), nativeSessionId ?? null, id);
    if (result.changes !== 1) this.throwTransitionError(id);
  }

  setNativeSessionId(id: string, nativeSessionId: string): void {
    if (typeof nativeSessionId !== 'string' || nativeSessionId.length === 0) {
      throw new Error('invalid_native_session_id');
    }
    const result = this.db.prepare(`
      UPDATE runs
      SET native_session_id = ?
      WHERE id = ? AND status = 'running' AND native_session_id IS NULL
    `).run(nativeSessionId, id);
    if (result.changes !== 1) this.throwTransitionError(id);
  }

  markQueuedFinished(id: string, status: 'failed' | 'cancelled', errorCode?: string): void {
    if (status !== 'failed' && status !== 'cancelled') throw new Error('invalid_run_status');
    const result = this.db.prepare(`
      UPDATE runs
      SET status = ?, error_code = ?, completed_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(status, errorCode ?? null, new Date().toISOString(), id);
    if (result.changes !== 1) this.throwTransitionError(id);
  }

  markFinished(
    id: string,
    status: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    errorCode?: string,
  ): void {
    if (!FINISHED_STATUSES.has(status)) throw new Error('invalid_run_status');
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE runs
      SET status = ?, error_code = ?, completed_at = ?,
          latency_ms = MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
      WHERE id = ? AND status = 'running'
    `).run(status, errorCode ?? null, now, now, id);
    if (result.changes !== 1) this.throwTransitionError(id);
  }

  list(limit?: number): RunRecord[] {
    if (limit === undefined) {
      return this.db.prepare<[], RunRow>(`
        SELECT
          id, client_id, extension_id, target_id, endpoint, status, response_id,
          native_session_id, error_code, queued_at, started_at, completed_at, latency_ms
        FROM runs
        ORDER BY queued_at DESC, rowid DESC
      `).all().map(toRunRecord);
    }
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('invalid_run_limit');
    return this.db.prepare<[number], RunRow>(`
      SELECT
        id, client_id, extension_id, target_id, endpoint, status, response_id,
        native_session_id, error_code, queued_at, started_at, completed_at, latency_ms
      FROM runs
      ORDER BY queued_at DESC, rowid DESC
      LIMIT ?
    `).all(limit).map(toRunRecord);
  }

  interruptUnfinished(): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE runs
      SET status = 'interrupted', completed_at = ?,
          latency_ms = CASE
            WHEN started_at IS NULL THEN NULL
            ELSE MAX(0, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER))
          END
      WHERE status IN ('queued', 'running')
    `).run(now, now);
    return result.changes;
  }

  private throwTransitionError(id: string): never {
    const row = this.db.prepare<[string], { id: string }>('SELECT id FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error('run_not_found');
    throw new Error('invalid_run_transition');
  }
}

export function reserveRunId(): string {
  return `run_${randomUUID()}`;
}

const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
