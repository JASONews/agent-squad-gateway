import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GatewayDb, openGatewayDb } from '../../src/control-plane/db.js';
import { ResponseSessionRepository } from '../../src/control-plane/response-sessions.js';

let db: GatewayDb | undefined;

afterEach(() => db?.close());

const ROOT_CREATED_AT = '2026-07-01T10:00:00.000Z';
const FIRST_CONTINUATION_AT = '2026-07-02T11:00:00.000Z';
const SECOND_CONTINUATION_AT = '2026-07-03T12:00:00.000Z';
const THIRTY_DAYS_LATER = '2026-08-01T11:00:00.000Z';
const FIRST_CHAIN_EXPIRY_MINUS_ONE = '2026-08-01T10:59:59.000Z';
const FIRST_CHAIN_EXPIRY_PLUS_ONE = '2026-08-01T11:00:01.000Z';

describe('ResponseSessionRepository', () => {
  it('stores only response metadata, builds a linear chain, and refreshes the full chain expiry', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const root = sessions.create({
      responseId: 'resp_root',
      targetId: 'target_a',
      nativeSessionId: 'native_root',
      workspacePath: '/gateway/root',
      now: ROOT_CREATED_AT,
    });

    expect(root).toEqual(expect.objectContaining({
      responseId: 'resp_root',
      chainId: 'resp_root',
      targetId: 'target_a',
      nativeSessionId: 'native_root',
      workspacePath: '/gateway/root',
      parentResponseId: null,
      childResponseId: null,
      stored: true,
      state: 'open',
      expiresAt: '2026-07-31T10:00:00.000Z',
      createdAt: ROOT_CREATED_AT,
      updatedAt: ROOT_CREATED_AT,
    }));
    expect(sessions.acquireContinuation('resp_root', 'target_a', FIRST_CONTINUATION_AT))
      .toEqual(expect.objectContaining({ state: 'continuing' }));
    const child = sessions.completeContinuation({
      parentResponseId: 'resp_root',
      childResponseId: 'resp_child',
      nativeSessionId: 'native_child',
      workspacePath: '/gateway/child',
      now: FIRST_CONTINUATION_AT,
    });

    expect(child).toEqual(expect.objectContaining({
      responseId: 'resp_child',
      chainId: 'resp_root',
      parentResponseId: 'resp_root',
      targetId: 'target_a',
      state: 'open',
      expiresAt: THIRTY_DAYS_LATER,
    }));
    expect(sessions.get('resp_root')).toEqual(expect.objectContaining({
      state: 'continued',
      childResponseId: 'resp_child',
      expiresAt: THIRTY_DAYS_LATER,
      updatedAt: FIRST_CONTINUATION_AT,
    }));

    sessions.acquireContinuation('resp_child', 'target_a', SECOND_CONTINUATION_AT);
    const grandchild = sessions.completeContinuation({
      parentResponseId: 'resp_child',
      childResponseId: 'resp_grandchild',
      nativeSessionId: 'native_grandchild',
      workspacePath: '/gateway/grandchild',
      now: SECOND_CONTINUATION_AT,
    });
    const expectedExpiry = '2026-08-02T12:00:00.000Z';

    expect(grandchild).toEqual(expect.objectContaining({
      chainId: 'resp_root', parentResponseId: 'resp_child', expiresAt: expectedExpiry,
    }));
    expect(['resp_root', 'resp_child', 'resp_grandchild'].map((id) => sessions.get(id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ responseId: 'resp_root', state: 'continued', expiresAt: expectedExpiry, updatedAt: SECOND_CONTINUATION_AT }),
        expect.objectContaining({ responseId: 'resp_child', state: 'continued', expiresAt: expectedExpiry, updatedAt: SECOND_CONTINUATION_AT }),
        expect.objectContaining({ responseId: 'resp_grandchild', state: 'open', expiresAt: expectedExpiry, updatedAt: SECOND_CONTINUATION_AT }),
      ]));

    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(response_sessions)')
      .all().map((column) => column.name);
    expect(columns).not.toEqual(expect.arrayContaining(['prompt', 'completion', 'payload', 'raw_tail']));
  });

  it('uses immediate transactions for every mutating method without a blocking contention probe', () => {
    db = openGatewayDb(':memory:');
    const immediate = spyOnImmediateTransactions(db);
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_lease', targetId: 'target_a', now: ROOT_CREATED_AT });

    sessions.acquireContinuation('resp_lease', 'target_a', FIRST_CONTINUATION_AT);
    expect(() => sessions.acquireContinuation('resp_lease', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_in_progress');
    expect(sessions.releaseBeforeStart('resp_lease', FIRST_CONTINUATION_AT)).toBe(true);
    sessions.acquireContinuation('resp_lease', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_lease',
      childResponseId: 'resp_lease_child',
      now: FIRST_CONTINUATION_AT,
    });
    sessions.acquireContinuation('resp_lease_child', 'target_a', SECOND_CONTINUATION_AT);
    sessions.failTerminal('resp_lease_child', SECOND_CONTINUATION_AT);
    sessions.expire('2026-09-01T00:00:00.000Z');

    expect(immediate).toHaveBeenCalledTimes(9);
  });

  it('attempts the guarded acquire update before classifying a zero-row transition', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_order', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_order', 'target_a', FIRST_CONTINUATION_AT);
    const statements = spyOnPreparedStatements(db);

    expect(() => sessions.acquireContinuation('resp_order', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_in_progress');

    expect(statements.map(normalizeSql)).toEqual([
      expect.stringMatching(/^UPDATE response_sessions SET state = 'continuing'/),
      expect.stringMatching(/^SELECT/),
    ]);
  });

  it('reopens only the active pre-start lease and rejects a completed parent', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_retry', targetId: 'target_a', now: ROOT_CREATED_AT });

    sessions.acquireContinuation('resp_retry', 'target_a', FIRST_CONTINUATION_AT);
    expect(sessions.releaseBeforeStart('resp_retry', FIRST_CONTINUATION_AT)).toBe(true);
    expect(sessions.releaseBeforeStart('resp_retry', FIRST_CONTINUATION_AT)).toBe(false);
    expect(sessions.get('resp_retry')).toEqual(expect.objectContaining({ state: 'open' }));

    sessions.acquireContinuation('resp_retry', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_retry',
      childResponseId: 'resp_retried',
      nativeSessionId: 'native_retried',
      workspacePath: '/gateway/retried',
      now: FIRST_CONTINUATION_AT,
    });
    expect(sessions.releaseBeforeStart('resp_retry', FIRST_CONTINUATION_AT)).toBe(false);
    expect(() => sessions.acquireContinuation('resp_retry', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_already_continued');
  });

  it('classifies missing, mismatched, not-stored, expired, and terminal responses precisely', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_target', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.create({
      responseId: 'resp_tombstone',
      targetId: 'target_a',
      nativeSessionId: 'must_not_persist',
      workspacePath: '/must/not/persist',
      store: false,
      now: ROOT_CREATED_AT,
    });
    sessions.create({ responseId: 'resp_expired', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.create({ responseId: 'resp_terminal', targetId: 'target_a', now: ROOT_CREATED_AT });

    expect(() => sessions.acquireContinuation('resp_missing', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_not_found');
    expect(() => sessions.acquireContinuation('resp_target', 'target_b', FIRST_CONTINUATION_AT))
      .toThrow('response_target_mismatch');
    expect(sessions.get('resp_tombstone')).toEqual(expect.objectContaining({
      stored: false,
      state: 'not_stored',
      nativeSessionId: null,
      workspacePath: null,
    }));
    expect(() => sessions.acquireContinuation('resp_tombstone', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_not_stored');

    expect(sessions.expire('2026-08-01T10:00:00.000Z')).toBe(4);
    expect(sessions.get('resp_expired')).toEqual(expect.objectContaining({ state: 'expired' }));
    expect(() => sessions.acquireContinuation('resp_expired', 'target_a', '2026-08-01T10:00:00.000Z'))
      .toThrow('response_expired');

    sessions.create({ responseId: 'resp_terminal_after_expiry', targetId: 'target_a', now: SECOND_CONTINUATION_AT });
    sessions.acquireContinuation('resp_terminal_after_expiry', 'target_a', SECOND_CONTINUATION_AT);
    sessions.failTerminal('resp_terminal_after_expiry', SECOND_CONTINUATION_AT);
    expect(() => sessions.acquireContinuation('resp_terminal_after_expiry', 'target_a', SECOND_CONTINUATION_AT))
      .toThrow('response_terminal_failure');
  });

  it('marks an entire chain terminal atomically and rolls back failed child insertion', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_failure_root', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_failure_root', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_failure_root',
      childResponseId: 'resp_failure_child',
      nativeSessionId: 'native_child',
      workspacePath: '/gateway/child',
      now: FIRST_CONTINUATION_AT,
    });
    sessions.acquireContinuation('resp_failure_child', 'target_a', SECOND_CONTINUATION_AT);
    sessions.failTerminal('resp_failure_child', SECOND_CONTINUATION_AT);

    expect(['resp_failure_root', 'resp_failure_child'].map((id) => sessions.get(id)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'terminal_failure', updatedAt: SECOND_CONTINUATION_AT }),
        expect.objectContaining({ state: 'terminal_failure', updatedAt: SECOND_CONTINUATION_AT }),
      ]));

    sessions.create({ responseId: 'resp_collision', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.create({ responseId: 'resp_taken_child', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_collision', 'target_a', FIRST_CONTINUATION_AT);
    const collisionSnapshot = snapshotResponseRows(db);
    expect(() => sessions.completeContinuation({
      parentResponseId: 'resp_collision',
      childResponseId: 'resp_taken_child',
      nativeSessionId: 'native_collision',
      workspacePath: '/gateway/collision',
      now: FIRST_CONTINUATION_AT,
    })).toThrow();
    expect(sessions.get('resp_collision')).toEqual(expect.objectContaining({
      state: 'continuing', childResponseId: null,
    }));
    expect(snapshotResponseRows(db)).toEqual(collisionSnapshot);
  });

  it('rejects failTerminal unless the initiating response is the continuing tail', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_open', targetId: 'target_a', now: ROOT_CREATED_AT });
    expect(() => sessions.failTerminal('resp_open', FIRST_CONTINUATION_AT))
      .toThrow('response_continuation_not_acquired');

    sessions.acquireContinuation('resp_open', 'target_a', FIRST_CONTINUATION_AT);
    sessions.releaseBeforeStart('resp_open', FIRST_CONTINUATION_AT);
    expect(() => sessions.failTerminal('resp_open', FIRST_CONTINUATION_AT))
      .toThrow('response_continuation_not_acquired');

    sessions.acquireContinuation('resp_open', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_open', childResponseId: 'resp_completed', now: FIRST_CONTINUATION_AT,
    });
    expect(() => sessions.failTerminal('resp_open', FIRST_CONTINUATION_AT))
      .toThrow('response_already_continued');

    sessions.acquireContinuation('resp_completed', 'target_a', SECOND_CONTINUATION_AT);
    expect(sessions.failTerminal('resp_completed', SECOND_CONTINUATION_AT)).toBe(2);
    expect(() => sessions.failTerminal('resp_completed', SECOND_CONTINUATION_AT))
      .toThrow('response_terminal_failure');

    sessions.create({ responseId: 'resp_not_stored', targetId: 'target_a', store: false, now: ROOT_CREATED_AT });
    expect(() => sessions.failTerminal('resp_not_stored', FIRST_CONTINUATION_AT))
      .toThrow('response_not_stored');
    expect(sessions.get('resp_not_stored')).toEqual(expect.objectContaining({ state: 'not_stored' }));
    sessions.create({ responseId: 'resp_fail_expired', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.expire('2026-07-31T10:00:00.000Z');
    expect(() => sessions.failTerminal('resp_fail_expired', '2026-07-31T10:00:00.000Z'))
      .toThrow('response_expired');
    expect(sessions.get('resp_fail_expired')).toEqual(expect.objectContaining({ state: 'expired' }));
    expect(() => sessions.failTerminal('resp_missing', FIRST_CONTINUATION_AT))
      .toThrow('response_not_found');
  });

  it('preserves release, completion, and late-failure ordering', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_release_first', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_release_first', 'target_a', FIRST_CONTINUATION_AT);
    expect(sessions.releaseBeforeStart('resp_release_first', FIRST_CONTINUATION_AT)).toBe(true);
    expect(() => sessions.failTerminal('resp_release_first', FIRST_CONTINUATION_AT))
      .toThrow('response_continuation_not_acquired');
    expect(sessions.get('resp_release_first')).toEqual(expect.objectContaining({ state: 'open' }));

    sessions.create({ responseId: 'resp_fail_first', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_fail_first', 'target_a', FIRST_CONTINUATION_AT);
    expect(sessions.failTerminal('resp_fail_first', FIRST_CONTINUATION_AT)).toBe(1);
    expect(sessions.releaseBeforeStart('resp_fail_first', FIRST_CONTINUATION_AT)).toBe(false);
    expect(sessions.get('resp_fail_first')).toEqual(expect.objectContaining({ state: 'terminal_failure' }));

    sessions.create({ responseId: 'resp_complete_first', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_complete_first', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_complete_first', childResponseId: 'resp_complete_child', now: FIRST_CONTINUATION_AT,
    });
    const completedSnapshot = snapshotResponseRows(db);
    expect(() => sessions.failTerminal('resp_complete_first', FIRST_CONTINUATION_AT))
      .toThrow('response_already_continued');
    expect(snapshotResponseRows(db)).toEqual(completedSnapshot);
  });

  it('rejects duplicate completion without inserting another child', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_duplicate', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_duplicate', 'target_a', FIRST_CONTINUATION_AT);
    sessions.completeContinuation({
      parentResponseId: 'resp_duplicate', childResponseId: 'resp_duplicate_child', now: FIRST_CONTINUATION_AT,
    });
    const snapshot = snapshotResponseRows(db);

    expect(() => sessions.completeContinuation({
      parentResponseId: 'resp_duplicate', childResponseId: 'resp_duplicate_late', now: FIRST_CONTINUATION_AT,
    })).toThrow('response_already_continued');
    expect(snapshotResponseRows(db)).toEqual(snapshot);
    expect(sessions.get('resp_duplicate_late')).toBeUndefined();
  });

  it('treats now equal to expiry as expired and keeps error precedence stable', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_boundary', targetId: 'target_a', now: ROOT_CREATED_AT });
    const boundarySnapshot = snapshotResponseRows(db);
    const expiry = '2026-07-31T10:00:00.000Z';

    expect(() => sessions.acquireContinuation('resp_boundary', 'target_a', expiry))
      .toThrow('response_expired');
    expect(snapshotResponseRows(db)).toEqual(boundarySnapshot);
    expect(() => sessions.acquireContinuation('resp_boundary', 'target_b', expiry))
      .toThrow('response_target_mismatch');

    sessions.create({ responseId: 'resp_boundary_tombstone', targetId: 'target_a', store: false, now: ROOT_CREATED_AT });
    expect(() => sessions.acquireContinuation('resp_boundary_tombstone', 'target_a', expiry))
      .toThrow('response_not_stored');
  });

  it('protects every due row in a continuing chain and refreshes it after completion', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const { root, tail } = createDueContinuingChain(sessions, 'complete_after_expiry');

    expect(sessions.expire(THIRTY_DAYS_LATER)).toBe(0);
    expect([root, tail].map((id) => sessions.get(id))).toEqual([
      expect.objectContaining({ state: 'continued', expiresAt: THIRTY_DAYS_LATER }),
      expect.objectContaining({ state: 'continuing', expiresAt: THIRTY_DAYS_LATER }),
    ]);

    const completed = sessions.completeContinuation({
      parentResponseId: tail,
      childResponseId: 'resp_complete_after_expiry_grandchild',
      now: FIRST_CHAIN_EXPIRY_PLUS_ONE,
    });
    const refreshedExpiry = '2026-08-31T11:00:01.000Z';

    expect(completed).toEqual(expect.objectContaining({ expiresAt: refreshedExpiry, state: 'open' }));
    expect([root, tail, completed.responseId].map((id) => sessions.get(id))).toEqual([
      expect.objectContaining({ state: 'continued', expiresAt: refreshedExpiry }),
      expect.objectContaining({ state: 'continued', expiresAt: refreshedExpiry }),
      expect.objectContaining({ state: 'open', expiresAt: refreshedExpiry }),
    ]);
  });

  it('allows a continuing lease to terminally fail after its old expiry', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const { root, tail } = createDueContinuingChain(sessions, 'fail_after_expiry');

    expect(sessions.expire(THIRTY_DAYS_LATER)).toBe(0);
    expect(sessions.failTerminal(tail, FIRST_CHAIN_EXPIRY_PLUS_ONE)).toBe(2);
    expect([root, tail].map((id) => sessions.get(id))).toEqual([
      expect.objectContaining({ state: 'terminal_failure' }),
      expect.objectContaining({ state: 'terminal_failure' }),
    ]);
  });

  it('expires a due chain after its continuing lease is released', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_released_after_expiry', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_released_after_expiry', 'target_a', '2026-07-31T09:59:59.000Z');

    expect(sessions.releaseBeforeStart('resp_released_after_expiry', '2026-07-31T10:00:01.000Z')).toBe(true);
    expect(sessions.expire('2026-07-31T10:00:01.000Z')).toBe(1);
    expect(sessions.get('resp_released_after_expiry')).toEqual(expect.objectContaining({ state: 'expired' }));
  });

  it('expires unrelated due chains while another chain has a continuing lease', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_active_lease', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.create({ responseId: 'resp_unrelated_due', targetId: 'target_a', now: ROOT_CREATED_AT });
    sessions.acquireContinuation('resp_active_lease', 'target_a', '2026-07-31T09:59:59.000Z');

    expect(sessions.expire('2026-07-31T10:00:00.000Z')).toBe(1);
    expect(sessions.get('resp_active_lease')).toEqual(expect.objectContaining({ state: 'continuing' }));
    expect(sessions.get('resp_unrelated_due')).toEqual(expect.objectContaining({ state: 'expired' }));
  });

  it('uses response_state_invalid for an unknown persisted state', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    sessions.create({ responseId: 'resp_bad_state', targetId: 'target_a', now: ROOT_CREATED_AT });
    db.prepare("UPDATE response_sessions SET state = 'unexpected' WHERE response_id = ?").run('resp_bad_state');

    expect(() => sessions.acquireContinuation('resp_bad_state', 'target_a', FIRST_CONTINUATION_AT))
      .toThrow('response_state_invalid');
  });

  it('requires the initiating response to be the open tail for acquire', () => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const { root } = createContinuingTail(sessions, 'acquire_tail');
    db.prepare("UPDATE response_sessions SET state = 'open' WHERE response_id = ?").run(root);
    const snapshot = snapshotResponseRows(db);

    expect(() => sessions.acquireContinuation(root, 'target_a', SECOND_CONTINUATION_AT))
      .toThrow('response_chain_invalid');
    expect(snapshotResponseRows(db)).toEqual(snapshot);
  });

  it.each([
    { kind: 'root', corrupt: (database: GatewayDb, root: string) => {
      database.prepare('UPDATE response_sessions SET parent_response_id = ? WHERE response_id = ?').run(root, root);
    }, operation: 'complete' },
    { kind: 'chain', corrupt: (database: GatewayDb, _root: string, tail: string) => {
      database.prepare("UPDATE response_sessions SET chain_id = 'resp_absent_root' WHERE response_id = ?").run(tail);
    }, operation: 'fail' },
    { kind: 'target', corrupt: (database: GatewayDb, _root: string, tail: string) => {
      database.prepare("UPDATE response_sessions SET target_id = 'target_b' WHERE response_id = ?").run(tail);
    }, operation: 'complete' },
    { kind: 'link', corrupt: (database: GatewayDb, root: string) => {
      database.prepare('UPDATE response_sessions SET child_response_id = NULL WHERE response_id = ?').run(root);
    }, operation: 'fail' },
    { kind: 'cycle', corrupt: (database: GatewayDb, root: string, tail: string) => {
      database.prepare('UPDATE response_sessions SET child_response_id = ? WHERE response_id = ?').run(root, tail);
    }, operation: 'complete' },
    { kind: 'extra row', corrupt: (database: GatewayDb, _root: string, tail: string) => {
      database.prepare(`
        INSERT INTO response_sessions (
          response_id, chain_id, target_id, native_session_id, parent_response_id,
          child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
        )
        SELECT 'resp_extra', chain_id, target_id, NULL, NULL, NULL, NULL, 1, 'open', expires_at, created_at, updated_at
        FROM response_sessions WHERE response_id = ?
      `).run(tail);
    }, operation: 'fail' },
  ] as const)('rejects $kind corruption before a chain-wide $operation mutation', ({ kind, corrupt, operation }) => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const { root, tail } = createContinuingTail(sessions, kind.replace(' ', '_'));
    corrupt(db, root, tail);
    const snapshot = snapshotResponseRows(db);

    const action = operation === 'complete'
      ? () => sessions.completeContinuation({
        parentResponseId: tail, childResponseId: `resp_${kind}_new`, now: SECOND_CONTINUATION_AT,
      })
      : () => sessions.failTerminal(tail, SECOND_CONTINUATION_AT);
    expect(action).toThrow('response_chain_invalid');
    expect(snapshotResponseRows(db)).toEqual(snapshot);
  });

  it.each([
    { kind: 'severed link', corrupt: (database: GatewayDb, root: string) => {
      database.prepare('UPDATE response_sessions SET child_response_id = NULL WHERE response_id = ?').run(root);
    } },
    { kind: 'root', corrupt: (database: GatewayDb, root: string) => {
      database.prepare('UPDATE response_sessions SET parent_response_id = ? WHERE response_id = ?').run(root, root);
    } },
    { kind: 'target', corrupt: (database: GatewayDb, _root: string, tail: string) => {
      database.prepare("UPDATE response_sessions SET target_id = 'target_b' WHERE response_id = ?").run(tail);
    } },
    { kind: 'extra row', corrupt: (database: GatewayDb, _root: string, tail: string) => {
      database.prepare(`
        INSERT INTO response_sessions (
          response_id, chain_id, target_id, native_session_id, parent_response_id,
          child_response_id, workspace_path, stored, state, expires_at, created_at, updated_at
        )
        SELECT 'resp_release_extra', chain_id, target_id, NULL, NULL, NULL, NULL, 1, 'open', expires_at, created_at, updated_at
        FROM response_sessions WHERE response_id = ?
      `).run(tail);
    } },
  ] as const)('rolls back release on $kind chain corruption', ({ corrupt }) => {
    db = openGatewayDb(':memory:');
    const sessions = new ResponseSessionRepository(db);
    const { root, tail } = createContinuingTail(sessions, 'release_corrupt');
    corrupt(db, root, tail);
    const snapshot = snapshotResponseRows(db);

    expect(() => sessions.releaseBeforeStart(tail, SECOND_CONTINUATION_AT))
      .toThrow('response_chain_invalid');
    expect(snapshotResponseRows(db)).toEqual(snapshot);
  });
});

function createContinuingTail(sessions: ResponseSessionRepository, suffix: string) {
  const root = `resp_${suffix}_root`;
  const tail = `resp_${suffix}_tail`;
  sessions.create({ responseId: root, targetId: 'target_a', now: ROOT_CREATED_AT });
  sessions.acquireContinuation(root, 'target_a', FIRST_CONTINUATION_AT);
  sessions.completeContinuation({ parentResponseId: root, childResponseId: tail, now: FIRST_CONTINUATION_AT });
  sessions.acquireContinuation(tail, 'target_a', SECOND_CONTINUATION_AT);
  return { root, tail };
}

function createDueContinuingChain(sessions: ResponseSessionRepository, suffix: string) {
  const root = `resp_${suffix}_root`;
  const tail = `resp_${suffix}_tail`;
  sessions.create({ responseId: root, targetId: 'target_a', now: ROOT_CREATED_AT });
  sessions.acquireContinuation(root, 'target_a', FIRST_CONTINUATION_AT);
  sessions.completeContinuation({ parentResponseId: root, childResponseId: tail, now: FIRST_CONTINUATION_AT });
  sessions.acquireContinuation(tail, 'target_a', FIRST_CHAIN_EXPIRY_MINUS_ONE);
  return { root, tail };
}

function snapshotResponseRows(database: GatewayDb) {
  return database.prepare<[], Record<string, unknown>>(
    'SELECT * FROM response_sessions ORDER BY response_id',
  ).all();
}

function spyOnImmediateTransactions(db: GatewayDb) {
  type ImmediateTransaction = (() => unknown) & { immediate(): unknown };
  type TransactionFactory = (fn: () => unknown) => ImmediateTransaction;
  const raw = db.raw as unknown as { transaction: TransactionFactory };
  const originalTransaction = raw.transaction.bind(raw);
  const immediate = vi.fn();

  vi.spyOn(raw, 'transaction').mockImplementation((fn) => {
    const transaction = originalTransaction(fn);
    const wrapped = (() => transaction()) as ImmediateTransaction;
    wrapped.immediate = () => {
      immediate();
      return transaction.immediate();
    };
    return wrapped;
  });

  return immediate;
}

function spyOnPreparedStatements(database: GatewayDb): string[] {
  const statements: string[] = [];
  const originalPrepare = database.prepare.bind(database);
  vi.spyOn(database, 'prepare').mockImplementation((sql) => {
    statements.push(sql);
    return originalPrepare(sql);
  });
  return statements;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
