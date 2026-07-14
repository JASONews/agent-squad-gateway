import { afterEach, describe, expect, it } from 'vitest';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { RunRepository } from '../../src/control-plane/runs.js';

let db: GatewayDb | undefined;

afterEach(() => db?.close());

describe('RunRepository', () => {
  it('persists metadata only and records exact state transitions', () => {
    db = openGatewayDb(':memory:');
    const runs = new RunRepository(db);
    const client = new ClientRepository(db).create('run-client');
    const run = runs.create({
      clientId: client.id,
      extensionId: 'openai',
      targetId: 'codex-gpt56-max',
      endpoint: '/v1/responses',
      responseId: 'resp_123',
    });

    expect(run).toMatchObject({
      clientId: client.id,
      extensionId: 'openai',
      targetId: 'codex-gpt56-max',
      endpoint: '/v1/responses',
      responseId: 'resp_123',
      status: 'queued',
      startedAt: null,
      completedAt: null,
      nativeSessionId: null,
      errorCode: null,
    });
    expect(run.queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => runs.markFinished(run.id, 'queued' as never))
      .toThrow('invalid_run_status');
    expect(() => runs.markFinished(run.id, 'failed', 'not_started'))
      .toThrow('invalid_run_transition');

    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(runs)')
      .all().map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining([
      'endpoint', 'status', 'queued_at', 'started_at', 'completed_at',
    ]));
    expect(columns).not.toEqual(expect.arrayContaining(['prompt', 'completion', 'raw_tail']));

    runs.markStarted(run.id, 'native-session-123');
    expect(() => runs.markStarted(run.id)).toThrow('invalid_run_transition');
    expect(runs.list()).toEqual([expect.objectContaining({
      id: run.id,
      status: 'running',
      nativeSessionId: 'native-session-123',
      startedAt: expect.any(String),
    })]);

    runs.markFinished(run.id, 'completed');
    expect(runs.list()).toEqual([expect.objectContaining({
      id: run.id,
      status: 'completed',
      completedAt: expect.any(String),
      latencyMs: expect.any(Number),
    })]);
    expect(() => runs.markFinished(run.id, 'failed', 'late_failure'))
      .toThrow('invalid_run_transition');
    expect(() => runs.markStarted('run_missing')).toThrow('run_not_found');
  });

  it('interrupts queued and running runs without modifying finished runs', () => {
    db = openGatewayDb(':memory:');
    const runs = new RunRepository(db);
    const queued = runs.create({
      extensionId: 'openai', targetId: 'target', endpoint: '/v1/chat/completions',
    });
    const running = runs.create({
      extensionId: 'openai', targetId: 'target', endpoint: '/v1/chat/completions',
    });
    const finished = runs.create({
      extensionId: 'openai', targetId: 'target', endpoint: '/v1/chat/completions',
    });
    runs.markStarted(running.id);
    runs.markStarted(finished.id);
    runs.markFinished(finished.id, 'failed', 'provider_failed');

    expect(runs.interruptUnfinished()).toBe(2);
    const byId = new Map(runs.list().map((run) => [run.id, run]));
    expect(byId.get(queued.id)).toMatchObject({ status: 'interrupted', completedAt: expect.any(String) });
    expect(byId.get(running.id)).toMatchObject({ status: 'interrupted', completedAt: expect.any(String) });
    expect(byId.get(finished.id)).toMatchObject({ status: 'failed', errorCode: 'provider_failed' });
  });
});
