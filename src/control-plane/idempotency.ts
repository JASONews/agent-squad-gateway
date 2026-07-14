import { createHash } from 'node:crypto';
import type { ReplayBuffer } from '../provider-runtime/replay-buffer.js';
import type { GatewayDb } from './db.js';
import type { RunRepository } from './runs.js';
import type { CreateRunInput } from './types.js';

const METADATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface IdempotencyRow {
  client_id: string;
  key_digest: string;
  request_hash: string;
  run_id: string;
  response_id: string | null;
  status: string;
  expires_at: string;
}

export interface IdempotencyBeginInput {
  clientId: string;
  key: string;
  endpoint: string;
  request: unknown;
  runId: string;
  responseId?: string | null;
  run: CreateRunInput;
}

interface IdempotencyDecisionBase {
  runId: string;
  responseId: string | null;
  clientId: string;
  keyDigest: string;
}

export type IdempotencyDecision = IdempotencyDecisionBase & {
  type: 'owner' | 'active_duplicate' | 'completed_replay' | 'unavailable';
};

export class IdempotencyConflictError extends Error {
  constructor() {
    super('idempotency_conflict');
  }
}

export interface IdempotencyServiceOptions {
  now?: () => number;
  metadataTtlMs?: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function serializeCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${serializeCanonicalJson(child)}`);
  return `{${entries.join(',')}}`;
}

export function canonicalizeRequest(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return 'null';
  return serializeCanonicalJson(JSON.parse(json) as unknown);
}

export class IdempotencyService {
  private readonly now: () => number;
  private readonly metadataTtlMs: number;

  constructor(
    private readonly db: GatewayDb,
    private readonly runs: Pick<RunRepository, 'create' | 'get' | 'markQueuedFinished'>,
    private readonly replay: ReplayBuffer,
    options: IdempotencyServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.metadataTtlMs = options.metadataTtlMs ?? METADATA_TTL_MS;
  }

  begin(input: IdempotencyBeginInput): IdempotencyDecision {
    const keyDigest = sha256(`${input.clientId}\0${input.endpoint}\0${input.key}`);
    const requestHash = sha256(`${input.endpoint}\0${canonicalizeRequest(input.request)}`);
    const decide = this.db.transaction((): IdempotencyDecision => {
      const existing = this.get(input.clientId, keyDigest);
      if (existing && Date.parse(existing.expires_at) <= this.now()) {
        this.db.prepare('DELETE FROM idempotency_keys WHERE client_id = ? AND key_digest = ?')
          .run(input.clientId, keyDigest);
      } else if (existing) {
        if (existing.request_hash !== requestHash) throw new IdempotencyConflictError();
        const base = this.decisionBase(existing);
        if (!this.replay.available(existing.run_id)) {
          return { ...base, type: 'unavailable' };
        }
        return {
          ...base,
          type: existing.status === 'active' ? 'active_duplicate' : 'completed_replay',
        };
      }

      this.runs.create(input.run, input.runId);
      this.db.prepare(`
        INSERT INTO idempotency_keys (
          client_id, key_digest, request_hash, run_id, response_id, status, expires_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(
        input.clientId,
        keyDigest,
        requestHash,
        input.runId,
        input.responseId ?? null,
        new Date(this.now() + this.metadataTtlMs).toISOString(),
      );
      this.replay.open(input.runId);
      return {
        type: 'owner',
        runId: input.runId,
        responseId: input.responseId ?? null,
        clientId: input.clientId,
        keyDigest,
      };
    });
    return decide();
  }

  async attach(decision: IdempotencyDecision): Promise<string[]> {
    if (decision.type === 'owner' || decision.type === 'unavailable') {
      throw new Error(decision.type === 'unavailable' ? 'idempotency_replay_unavailable' : 'idempotency_owner_cannot_attach');
    }
    const chunks: string[] = [];
    for await (const chunk of this.replay.subscribe(decision.runId)) chunks.push(chunk);
    return chunks;
  }

  complete(decision: IdempotencyDecision, serialized: string): void {
    this.settle(decision, 'completed', serialized);
  }

  fail(decision: IdempotencyDecision, serialized: string): void {
    this.settle(decision, 'failed', serialized);
    const run = this.runs.get(decision.runId);
    if (run?.status === 'queued') {
      this.runs.markQueuedFinished(decision.runId, 'failed', 'idempotency_owner_failed');
    }
  }

  private settle(decision: IdempotencyDecision, status: 'completed' | 'failed', serialized: string): void {
    if (decision.type !== 'owner') throw new Error('idempotency_not_owner');
    const result = this.db.prepare(`
      UPDATE idempotency_keys SET status = ?
      WHERE client_id = ? AND key_digest = ? AND run_id = ? AND status = 'active'
    `).run(status, decision.clientId, decision.keyDigest, decision.runId);
    if (result.changes !== 1) throw new Error('invalid_idempotency_transition');
    if (this.replay.available(decision.runId)) {
      try {
        this.replay.publish(decision.runId, serialized);
        this.replay.complete(decision.runId);
      } catch {
        this.replay.evict(decision.runId);
      }
    }
  }

  private get(clientId: string, keyDigest: string): IdempotencyRow | undefined {
    return this.db.prepare<[string, string], IdempotencyRow>(`
      SELECT client_id, key_digest, request_hash, run_id, response_id, status, expires_at
      FROM idempotency_keys WHERE client_id = ? AND key_digest = ?
    `).get(clientId, keyDigest);
  }

  private decisionBase(row: IdempotencyRow): IdempotencyDecisionBase {
    return {
      runId: row.run_id,
      responseId: row.response_id,
      clientId: row.client_id,
      keyDigest: row.key_digest,
    };
  }
}
