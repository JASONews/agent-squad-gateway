import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CoreConnectionRepository } from '../../src/control-plane/core-connection.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { ensureSecretFile } from '../../src/security/secret-files.js';
import { buildGatewayApp } from '../../src/server/app.js';

const ISO = '2026-07-12T12:00:00.000Z';
const ADMIN_SECRET_BYTES = Buffer.from('local-admin-secret');
const ADMIN_SECRET = ADMIN_SECRET_BYTES.toString('base64url');
const SESSION = { id: 'sess_1', root_task: 'Review retries', repo_path: '/repo', main_peer_id: 'main', created_at: ISO, updated_at: ISO };
const OPTION = { id: 'safe', label: 'Safe' };
const FAST_OPTION = { id: 'fast', label: 'Fast' };

let gateway: FastifyInstance;
let core: FastifyInstance;
let db: GatewayDb;
let baseDir: string;
let headers: Record<string, string>;
let coreAddress: string;
let requests: Array<{ method: string; url: string; body: unknown }>;
let currentChoiceStatus: string;
let currentChoiceSelected: string | null;
let currentChoiceRationale: string | null;
let currentChoiceOptions: Array<{ id: string; label: string }>;
let choiceReadBarrier: (() => Promise<void>) | undefined;
let eventMode: 'eof' | 'hello-eof' | 'hold';
let eventConnections: number;
let eventCloses: number;
let instantReconnects: boolean;
let reconnectDelays: number[];

function choice(
  sessionId = 'sess_1',
  id = 'choice_1',
  status = 'pending_main_agent',
  selected: string | null = null,
  rationale: string | null = null,
  options = [OPTION],
) {
  return {
    id, session_id: sessionId, requester_subagent_id: 'sub_1', target_peer_id: 'main', question: 'Which?',
    options_json: JSON.stringify(options), recommendation_json: null, status, selected,
    rationale, created_at: ISO, resolved_at: status === 'resolved' ? ISO : null,
  };
}

function barrier(parties: number): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    if (arrivals >= parties) return;
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
  };
}

function json(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

beforeEach(async () => {
  requests = [];
  currentChoiceStatus = 'pending_main_agent';
  currentChoiceSelected = null;
  currentChoiceRationale = null;
  currentChoiceOptions = [OPTION];
  choiceReadBarrier = undefined;
  eventMode = 'eof';
  eventConnections = 0;
  eventCloses = 0;
  instantReconnects = false;
  reconnectDelays = [];
  core = Fastify({ logger: false });
  core.addHook('preHandler', (request, _reply, done) => {
    requests.push({ method: request.method, url: request.url, body: request.body });
    done();
  });
  core.get('/v1/health', async () => ({ ok: true, version: '0.1.0', db_ok: true }));
  core.get('/v1/sessions', async () => ({ sessions: [SESSION] }));
  core.get('/v1/sessions/:id/subagents', async () => ({ subagents: [] }));
  core.get('/v1/sessions/:id/messages', async () => ({ messages: [] }));
  core.get('/v1/sessions/:id/choices', async (request) => {
    await choiceReadBarrier?.();
    return {
      choices: [choice(
        (request.params as { id: string }).id,
        'choice_1',
        currentChoiceStatus,
        currentChoiceSelected,
        currentChoiceRationale,
        currentChoiceOptions,
      )],
    };
  });
  core.post('/v1/sessions/:id/choices/:choiceId/resolve', async (request) => {
    const input = request.body as { selected: string; rationale?: string };
    if (currentChoiceStatus === 'pending_main_agent') {
      currentChoiceStatus = 'resolved';
      currentChoiceSelected = input.selected;
      currentChoiceRationale = input.rationale ?? null;
    }
    return { status: 'resolved' };
  });
  core.get('/v1/events', async (request, reply) => {
    eventConnections += 1;
    request.raw.once('close', () => { eventCloses += 1; });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('data: {"type":"hello","payload":{}}\n\n');
    if (eventMode !== 'hello-eof') {
      reply.raw.write('data: {"type":"subagent_status","payload":{"session_id":"sess_1","text":"sensitive output","raw_tail":"sensitive tail","content":"sensitive content"}}\n\n');
    }
    if (eventMode === 'eof') reply.raw.end();
    if (eventMode === 'hello-eof') reply.raw.end();
  });
  coreAddress = await core.listen({ host: '127.0.0.1', port: 0 });

  baseDir = fs.mkdtempSync(join(tmpdir(), 'asq-gw-core-routes-'));
  const config = resolveGatewayConfig({ baseDir, coreUrl: coreAddress, webUiAuth: 'token' });
  const masterKey = ensureSecretFile(config.paths.masterKeyPath, 32);
  fs.writeFileSync(config.paths.adminSecretPath, ADMIN_SECRET_BYTES, { mode: 0o600 });
  db = openGatewayDb(':memory:');
  new CoreConnectionRepository(db).update(coreAddress);
  gateway = buildGatewayApp({
    config, db,
    clients: new ClientRepository(db), credentials: new CredentialService(db, masterKey),
    targets: new TargetRepository(db), grants: new GrantRepository(db),
    extensions: new ExtensionRepository(db), runs: new RunRepository(db),
    adminAuth: new AdminAuthService(db, ADMIN_SECRET_BYTES),
    coreEventProxyOptions: {
      setTimeout: ((callback, delay, ...args) => {
        if (instantReconnects) reconnectDelays.push(delay ?? 0);
        return globalThis.setTimeout(callback, instantReconnects ? 0 : delay, ...args);
      }) as typeof globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    },
  });
  await gateway.ready();

  const mint = await gateway.inject({ method: 'POST', url: '/admin/bootstrap/mint', headers: { authorization: `Bearer ${ADMIN_SECRET}` } });
  const exchange = await gateway.inject({ method: 'POST', url: '/admin/bootstrap/exchange', payload: { code: json(mint).code } });
  headers = {
    cookie: exchange.headers['set-cookie']!.split(';', 1)[0]!,
    origin: 'http://127.0.0.1:28772',
    'x-csrf-token': json(exchange).csrf_token as string,
  };
});

afterEach(async () => {
  await gateway.close();
  await core.close();
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('authenticated Core observability routes', () => {
  it('requires admin auth on every route and Origin/CSRF on resolution', async () => {
    for (const url of ['/admin/core/health', '/admin/core/sessions', '/admin/core/sessions/sess_1/debug', '/admin/core/choices?status=pending', '/admin/core/events']) {
      const response = await gateway.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
    const withoutCsrf = await gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers: { cookie: headers.cookie }, payload: { selected: 'safe' } });
    expect(withoutCsrf.statusCode).toBe(403);
  });

  it('rejects cookie-only debug reads while cookie plus CSRF succeeds', async () => {
    const url = '/admin/core/sessions/sess_1/debug';
    const cookieOnly = await gateway.inject({
      method: 'GET', url, headers: { cookie: headers.cookie },
    });
    expect(cookieOnly.statusCode).toBe(403);
    expect(json(cookieOnly)).toMatchObject({ error: { code: 'csrf_invalid' } });

    const authorized = await gateway.inject({ method: 'GET', url, headers });
    expect(authorized.statusCode).toBe(200);
    expect(json(authorized)).toMatchObject({ session: SESSION });
  });

  it('proxies health, sessions, and a live debug bundle without persistence', async () => {
    const health = await gateway.inject({ method: 'GET', url: '/admin/core/health', headers });
    expect(health.statusCode).toBe(200);
    expect(json(health)).toMatchObject({ ok: true, version: '0.1.0', db_ok: true, connection: { status: 'online', baseUrl: coreAddress } });

    const sessions = await gateway.inject({ method: 'GET', url: '/admin/core/sessions', headers });
    expect(json(sessions)).toEqual({ sessions: [SESSION] });

    const debug = await gateway.inject({ method: 'GET', url: '/admin/core/sessions/sess_1/debug', headers });
    expect(json(debug)).toMatchObject({ session: SESSION, subagents: [], messages: [], choices: [{ id: 'choice_1', options: [OPTION] }] });
    expect(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE sql LIKE '%raw_tail%' OR sql LIKE '%root_task%'").all()).toEqual([]);
  });

  it('aggregates pending choices with at most four live requests and no stored result', async () => {
    await core.close();
    let active = 0;
    let maxActive = 0;
    core = Fastify({ logger: false });
    const sessions = Array.from({ length: 9 }, (_, index) => ({ ...SESSION, id: `sess_${index}` }));
    core.get('/v1/sessions', async () => ({ sessions }));
    core.get('/v1/sessions/:id/choices', async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      const { id } = request.params as { id: string };
      return { choices: [choice(id, `choice_${id}`, id === 'sess_8' ? 'resolved' : 'pending_main_agent')] };
    });
    const replacementAddress = await core.listen({ host: '127.0.0.1', port: Number(new URL(coreAddress).port) });
    expect(replacementAddress).toBe(coreAddress);

    const response = await gateway.inject({ method: 'GET', url: '/admin/core/choices?status=pending', headers });
    expect(response.statusCode).toBe(200);
    expect((json(response).choices as unknown[])).toHaveLength(8);
    expect(maxActive).toBe(4);
    expect(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE sql LIKE '%requester_subagent_id%'").all()).toEqual([]);
  });

  it('allows only a current pending option to be resolved', async () => {
    const invalid = await gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers, payload: { selected: 'unknown' } });
    expect(invalid.statusCode).toBe(400);
    expect(json(invalid)).toMatchObject({ error: { code: 'core_choice_option_invalid' } });

    const resolved = await gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers, payload: { selected: 'safe', rationale: 'bounded' } });
    expect(resolved.statusCode).toBe(204);
    expect(requests.findLast((request) => request.method === 'POST')).toEqual({
      method: 'POST', url: '/v1/sessions/sess_1/choices/choice_1/resolve',
      body: { selected: 'safe', rationale: 'bounded' },
    });

    currentChoiceStatus = 'resolved';
    const stale = await gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers, payload: { selected: 'safe' } });
    expect(stale.statusCode).toBe(409);
    expect(json(stale)).toMatchObject({ error: { code: 'core_choice_not_pending' } });
  });

  it('returns 204 only for the selection applied by concurrent Core resolution', async () => {
    currentChoiceOptions = [OPTION, FAST_OPTION];
    choiceReadBarrier = barrier(2);

    const [safe, fast] = await Promise.all([
      gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers, payload: { selected: 'safe', rationale: 'safe reason' } }),
      gateway.inject({ method: 'POST', url: '/admin/core/sessions/sess_1/choices/choice_1/resolve', headers, payload: { selected: 'fast', rationale: 'fast reason' } }),
    ]);

    const responses = new Map([['safe', safe], ['fast', fast]]);
    const applied = responses.get(currentChoiceSelected!);
    const loser = responses.get(currentChoiceSelected === 'safe' ? 'fast' : 'safe');
    expect(applied?.statusCode).toBe(204);
    expect(loser?.statusCode).toBe(409);
    expect(json(loser!)).toMatchObject({ error: { code: 'core_choice_not_pending' } });
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
  });

  it('does not expose Core creation, messaging, process, or termination mutations', async () => {
    const forbidden = [
      ['POST', '/admin/core/sessions'], ['POST', '/admin/core/sessions/sess_1/subagents'],
      ['POST', '/admin/core/sessions/sess_1/subagents/rev/messages'], ['POST', '/admin/core/sessions/sess_1/start'],
      ['POST', '/admin/core/sessions/sess_1/stop'], ['POST', '/admin/core/sessions/sess_1/restart'],
      ['POST', '/admin/core/sessions/sess_1/kill'], ['POST', '/admin/core/sessions/sess_1/terminate'],
    ];
    for (const [method, url] of forbidden) {
      const response = await gateway.inject({ method, url, headers, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('forwards only Core invalidation metadata and reconnects after upstream EOF', async () => {
    const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${gatewayAddress}/admin/core/events`, {
      headers: { cookie: headers.cookie }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    let wire = '';
    while (eventConnections < 2) {
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('SSE reconnect timeout')), 1_000)),
      ]);
      if (result.done) break;
      wire += new TextDecoder().decode(result.value);
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    expect(eventConnections).toBeGreaterThanOrEqual(2);
    expect(wire).toContain('"type":"core_connection"');
    expect(wire).toContain('"status":"online"');
    expect(wire).toContain('"status":"reconnecting"');
    expect(wire).toContain('"type":"hello"');
    expect(wire).toContain('"type":"subagent_status"');
    expect(wire).toContain('"session_id":"sess_1"');
    expect(wire).not.toMatch(/sensitive|raw_tail|content|text/);
  });

  it('advances reconnect backoff across mandatory hello plus EOF failures', async () => {
    eventMode = 'hello-eof';
    instantReconnects = true;
    const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${gatewayAddress}/admin/core/events`, {
      headers: { cookie: headers.cookie }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    while (reconnectDelays.length < 4) {
      await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('SSE delay sequence timeout')), 1_000)),
      ]);
    }
    controller.abort();
    await reader.cancel().catch(() => undefined);

    expect(reconnectDelays.slice(0, 4)).toEqual([250, 1_000, 2_000, 5_000]);
  });

  it('aborts the upstream SSE request when the browser disconnects', async () => {
    eventMode = 'hold';
    const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${gatewayAddress}/admin/core/events`, {
      headers: { cookie: headers.cookie }, signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => undefined);

    await waitFor(() => eventCloses >= 1);
    expect(eventConnections).toBe(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
