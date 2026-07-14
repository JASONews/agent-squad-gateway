import type { GatewayDb } from './db.js';

const RESPONSE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ResponseSessionState =
  | 'open'
  | 'continuing'
  | 'continued'
  | 'terminal_failure'
  | 'not_stored'
  | 'expired';

export interface ResponseSessionRecord {
  responseId: string;
  chainId: string;
  targetId: string;
  nativeSessionId: string | null;
  parentResponseId: string | null;
  childResponseId: string | null;
  workspacePath: string | null;
  stored: boolean;
  state: ResponseSessionState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateResponseSessionInput {
  responseId: string;
  targetId: string;
  nativeSessionId?: string | null;
  workspacePath?: string | null;
  store?: boolean;
  now?: string;
}

export interface CompleteContinuationInput {
  parentResponseId: string;
  childResponseId: string;
  nativeSessionId?: string | null;
  workspacePath?: string | null;
  now?: string;
}

interface ResponseSessionRow {
  response_id: string;
  chain_id: string;
  target_id: string;
  native_session_id: string | null;
  parent_response_id: string | null;
  child_response_id: string | null;
  workspace_path: string | null;
  stored: number;
  state: ResponseSessionState;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface ResponseRetentionRow {
  response_id: string;
  chain_id: string;
  workspace_path: string | null;
}

export interface ResponseRetentionChain {
  chainId: string;
  responseIds: string[];
  workspacePaths: string[];
}

interface ValidResponseChain {
  rows: ResponseSessionRow[];
  tail: ResponseSessionRow;
}

function toResponseSessionRecord(row: ResponseSessionRow): ResponseSessionRecord {
  return {
    responseId: row.response_id,
    chainId: row.chain_id,
    targetId: row.target_id,
    nativeSessionId: row.native_session_id,
    parentResponseId: row.parent_response_id,
    childResponseId: row.child_response_id,
    workspacePath: row.workspace_path,
    stored: row.stored === 1,
    state: row.state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ResponseSessionRepository {
  private readonly retentionHidden = new Set<string>();

  constructor(private readonly db: GatewayDb) {}

  create(input: CreateResponseSessionInput): ResponseSessionRecord {
    assertIdentifier(input.responseId, 'response_id');
    assertIdentifier(input.targetId, 'response_target');
    const now = toIsoTimestamp(input.now);
    const stored = input.store !== false;
    const record: ResponseSessionRecord = {
      responseId: input.responseId,
      chainId: input.responseId,
      targetId: input.targetId,
      nativeSessionId: stored ? input.nativeSessionId ?? null : null,
      parentResponseId: null,
      childResponseId: null,
      workspacePath: stored ? input.workspacePath ?? null : null,
      stored,
      state: stored ? 'open' : 'not_stored',
      expiresAt: plusTtl(now),
      createdAt: now,
      updatedAt: now,
    };

    const transaction = this.db.raw.transaction(() => this.db.prepare(`
      INSERT INTO response_sessions (
        response_id, chain_id, target_id, native_session_id, parent_response_id,
        child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.responseId,
      record.chainId,
      record.targetId,
      record.nativeSessionId,
      record.parentResponseId,
      record.childResponseId,
      record.workspacePath,
      record.stored ? 1 : 0,
      record.state,
      record.expiresAt,
      record.createdAt,
      record.updatedAt,
    ));
    transaction.immediate();
    return record;
  }

  acquireContinuation(parentResponseId: string, targetId: string, now?: string): ResponseSessionRecord {
    assertIdentifier(parentResponseId, 'parent_response_id');
    assertIdentifier(targetId, 'response_target');
    const timestamp = toIsoTimestamp(now);
    const transaction = this.db.raw.transaction(() => {
      const result = this.db.prepare(`
        UPDATE response_sessions
        SET state = 'continuing', updated_at = ?
        WHERE response_id = ? AND target_id = ? AND state = 'open'
          AND stored = 1 AND expires_at > ?
      `).run(timestamp, parentResponseId, targetId, timestamp);
      if (result.changes !== 1) this.classifyAcquireFailure(parentResponseId, targetId, timestamp);

      const parent = this.requireRow(parentResponseId);
      const chain = this.requireValidChain(parent);
      this.assertActiveTail(chain, parent);

      return toResponseSessionRecord(parent);
    });

    return transaction.immediate();
  }

  completeContinuation(input: CompleteContinuationInput): ResponseSessionRecord {
    assertIdentifier(input.parentResponseId, 'parent_response_id');
    assertIdentifier(input.childResponseId, 'child_response_id');
    const now = toIsoTimestamp(input.now);
    const transaction = this.db.raw.transaction(() => {
      const parent = this.findRow(input.parentResponseId);
      this.assertCompletableParent(parent, now);
      const chain = this.requireValidChain(parent);
      this.assertActiveTail(chain, parent);
      const expiresAt = plusTtl(now);

      this.db.prepare(`
        INSERT INTO response_sessions (
          response_id, chain_id, target_id, native_session_id, parent_response_id,
          child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 'open', ?, ?, ?)
      `).run(
        input.childResponseId,
        parent.chain_id,
        parent.target_id,
        input.nativeSessionId ?? null,
        parent.response_id,
        input.workspacePath ?? null,
        expiresAt,
        now,
        now,
      );

      const completed = this.db.prepare(`
        UPDATE response_sessions
        SET state = 'continued', child_response_id = ?, updated_at = ?
        WHERE response_id = ? AND chain_id = ? AND target_id = ?
          AND state = 'continuing' AND child_response_id IS NULL
      `).run(input.childResponseId, now, input.parentResponseId, parent.chain_id, parent.target_id);
      if (completed.changes !== 1) throw new Error('response_state_invalid');

      const refreshed = this.db.prepare(`
        UPDATE response_sessions
        SET expires_at = ?, updated_at = ?
        WHERE chain_id = ? AND target_id = ?
      `).run(expiresAt, now, parent.chain_id, parent.target_id);
      if (refreshed.changes !== chain.rows.length + 1) throw new Error('response_chain_invalid');

      return toResponseSessionRecord(this.requireRow(input.childResponseId));
    });

    return transaction.immediate();
  }

  releaseBeforeStart(parentResponseId: string, now?: string): boolean {
    assertIdentifier(parentResponseId, 'parent_response_id');
    const timestamp = toIsoTimestamp(now);
    const transaction = this.db.raw.transaction(() => {
      const parent = this.findRow(parentResponseId);
      if (!parent || parent.state !== 'continuing') return false;
      const chain = this.requireValidChain(parent);
      this.assertActiveTail(chain, parent);

      return this.db.prepare(`
        UPDATE response_sessions
        SET state = 'open', updated_at = ?
        WHERE response_id = ? AND state = 'continuing'
      `).run(timestamp, parentResponseId).changes === 1;
    });

    return transaction.immediate();
  }

  failTerminal(responseId: string, now?: string): number {
    assertIdentifier(responseId, 'response_id');
    const timestamp = toIsoTimestamp(now);
    const transaction = this.db.raw.transaction(() => {
      const session = this.findRow(responseId);
      this.assertCompletableParent(session, timestamp);
      const chain = this.requireValidChain(session);
      this.assertActiveTail(chain, session);
      const failed = this.db.prepare(`
        UPDATE response_sessions
        SET state = 'terminal_failure', updated_at = ?
        WHERE chain_id = ? AND target_id = ?
      `).run(timestamp, session.chain_id, session.target_id);
      if (failed.changes !== chain.rows.length) throw new Error('response_chain_invalid');
      return failed.changes;
    });

    return transaction.immediate();
  }

  get(responseId: string): ResponseSessionRecord | undefined {
    assertIdentifier(responseId, 'response_id');
    if (this.retentionHidden.has(responseId)) return undefined;
    const row = this.findRow(responseId);
    return row ? toResponseSessionRecord(row) : undefined;
  }

  findExpiredForRetention(now: string): ResponseRetentionChain[] {
    const timestamp = toIsoTimestamp(now);
    const rows = this.db.prepare<[string], ResponseRetentionRow>(`
      SELECT candidate.response_id, candidate.chain_id, candidate.workspace_path
      FROM response_sessions AS candidate
      WHERE candidate.chain_id IN (
        SELECT chain_id
        FROM response_sessions
        GROUP BY chain_id
        HAVING MAX(expires_at) <= ?
          AND SUM(CASE WHEN state = 'continuing' THEN 1 ELSE 0 END) = 0
      )
      ORDER BY candidate.chain_id, candidate.response_id
    `).all(timestamp);
    const chains = new Map<string, ResponseRetentionChain>();
    for (const row of rows) {
      let chain = chains.get(row.chain_id);
      if (!chain) {
        chain = { chainId: row.chain_id, responseIds: [], workspacePaths: [] };
        chains.set(row.chain_id, chain);
      }
      chain.responseIds.push(row.response_id);
      if (row.workspace_path !== null && !chain.workspacePaths.includes(row.workspace_path)) {
        chain.workspacePaths.push(row.workspace_path);
      }
    }
    return [...chains.values()];
  }

  hideForRetention(chains: readonly ResponseRetentionChain[]): void {
    for (const chain of chains) {
      for (const responseId of chain.responseIds) this.retentionHidden.add(responseId);
    }
  }

  releaseRetentionHidden(chains: readonly ResponseRetentionChain[]): void {
    for (const chain of chains) {
      for (const responseId of chain.responseIds) this.retentionHidden.delete(responseId);
    }
  }

  unlinkAndDeleteForRetention(chainIds: readonly string[]): number {
    let deleted = 0;
    const unlink = this.db.prepare(`
      UPDATE response_sessions
      SET parent_response_id = NULL, child_response_id = NULL
      WHERE chain_id = ?
    `);
    const remove = this.db.prepare('DELETE FROM response_sessions WHERE chain_id = ?');
    for (const chainId of chainIds) {
      unlink.run(chainId);
      deleted += remove.run(chainId).changes;
    }
    return deleted;
  }

  expire(now?: string): number {
    const timestamp = toIsoTimestamp(now);
    const transaction = this.db.raw.transaction(() => this.db.prepare(`
      UPDATE response_sessions AS candidate
      SET state = 'expired', updated_at = ?
      WHERE candidate.expires_at <= ? AND candidate.state != 'expired'
        AND NOT EXISTS (
          SELECT 1
          FROM response_sessions AS lease
          WHERE lease.chain_id = candidate.chain_id
            AND lease.target_id = candidate.target_id
            AND lease.state = 'continuing'
        )
    `).run(timestamp, timestamp).changes);

    return transaction.immediate();
  }

  private findRow(responseId: string): ResponseSessionRow | undefined {
    return this.db.prepare<[string], ResponseSessionRow>(`
      SELECT
        response_id, chain_id, target_id, native_session_id, parent_response_id,
        child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
      FROM response_sessions
      WHERE response_id = ?
    `).get(responseId);
  }

  private requireRow(responseId: string): ResponseSessionRow {
    const row = this.findRow(responseId);
    if (!row) throw new Error('response_not_found');
    return row;
  }

  private findChainRows(chainId: string): ResponseSessionRow[] {
    return this.db.prepare<[string], ResponseSessionRow>(`
      SELECT
        response_id, chain_id, target_id, native_session_id, parent_response_id,
        child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
      FROM response_sessions
      WHERE chain_id = ?
    `).all(chainId);
  }

  private assertTarget(row: ResponseSessionRow | undefined, targetId: string): asserts row is ResponseSessionRow {
    if (!row) throw new Error('response_not_found');
    if (row.target_id !== targetId) throw new Error('response_target_mismatch');
  }

  private assertCompletableParent(row: ResponseSessionRow | undefined, now: string): asserts row is ResponseSessionRow {
    if (!row) throw new Error('response_not_found');
    if (row.stored !== 1 || row.state === 'not_stored') throw new Error('response_not_stored');
    if (row.state === 'continuing') return;
    if (row.state === 'expired' || row.expires_at <= now) throw new Error('response_expired');
    switch (row.state) {
      case 'open': throw new Error('response_continuation_not_acquired');
      case 'continued': throw new Error('response_already_continued');
      case 'terminal_failure': throw new Error('response_terminal_failure');
      default: throw new Error('response_state_invalid');
    }
  }

  private assertAcquirableState(row: ResponseSessionRow): void {
    switch (row.state) {
      case 'open': return;
      case 'continuing': throw new Error('response_in_progress');
      case 'continued': throw new Error('response_already_continued');
      case 'terminal_failure': throw new Error('response_terminal_failure');
      case 'not_stored': throw new Error('response_not_stored');
      case 'expired': throw new Error('response_expired');
      default: throw new Error('response_state_invalid');
    }
  }

  private classifyAcquireFailure(responseId: string, targetId: string, now: string): never {
    if (this.retentionHidden.has(responseId)) throw new Error('response_not_found');
    const parent = this.findRow(responseId);
    this.assertTarget(parent, targetId);
    this.assertStoredAndUnexpired(parent, now);
    this.assertAcquirableState(parent);
    throw new Error('response_state_invalid');
  }

  private assertStoredAndUnexpired(row: ResponseSessionRow, now: string): void {
    if (row.stored !== 1 || row.state === 'not_stored') throw new Error('response_not_stored');
    if (row.state === 'expired' || row.expires_at <= now) throw new Error('response_expired');
  }

  private requireValidChain(session: ResponseSessionRow): ValidResponseChain {
    const rows = this.findChainRows(session.chain_id);
    const byId = new Map(rows.map((row) => [row.response_id, row]));
    const root = byId.get(session.chain_id);
    if (
      !root
      || root.response_id !== root.chain_id
      || root.parent_response_id !== null
      || root.target_id !== session.target_id
    ) {
      throw new Error('response_chain_invalid');
    }

    for (const row of rows) {
      if (row.chain_id !== session.chain_id || row.target_id !== session.target_id) {
        throw new Error('response_chain_invalid');
      }
      if (row.response_id !== root.response_id) {
        const parent = row.parent_response_id === null ? undefined : byId.get(row.parent_response_id);
        if (!parent || parent.child_response_id !== row.response_id) {
          throw new Error('response_chain_invalid');
        }
      }
      if (row.child_response_id !== null) {
        const child = byId.get(row.child_response_id);
        if (!child || child.parent_response_id !== row.response_id) {
          throw new Error('response_chain_invalid');
        }
      }
    }

    const ordered: ResponseSessionRow[] = [];
    const visited = new Set<string>();
    let current: ResponseSessionRow | undefined = root;
    while (current) {
      if (visited.has(current.response_id)) throw new Error('response_chain_invalid');
      visited.add(current.response_id);
      ordered.push(current);
      current = current.child_response_id === null ? undefined : byId.get(current.child_response_id);
    }
    if (ordered.length !== rows.length) throw new Error('response_chain_invalid');

    const tail = ordered.at(-1);
    if (!tail) throw new Error('response_chain_invalid');
    return { rows: ordered, tail };
  }

  private assertActiveTail(chain: ValidResponseChain, session: ResponseSessionRow): void {
    if (chain.tail.response_id !== session.response_id || session.child_response_id !== null) {
      throw new Error('response_chain_invalid');
    }
    for (const row of chain.rows.slice(0, -1)) {
      if (row.stored !== 1 || row.state !== 'continued') throw new Error('response_state_invalid');
    }
  }
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`invalid_${name}`);
}

function toIsoTimestamp(value?: string): string {
  const date = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('invalid_response_timestamp');
  return date.toISOString();
}

function plusTtl(now: string): string {
  return new Date(new Date(now).getTime() + RESPONSE_SESSION_TTL_MS).toISOString();
}
