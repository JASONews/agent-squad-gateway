import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient, CoreClientError, parseCoreBaseUrl } from '../../src/core-client/client.js';
import { CoreConnectionRepository } from '../../src/control-plane/core-connection.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';

const ISO = '2026-07-12T12:00:00.000Z';
const SESSION = {
  id: 'sess_1', root_task: 'Review retries', repo_path: '/repo', main_peer_id: 'main',
  created_at: ISO, updated_at: ISO,
};
const SUBAGENT = {
  id: 'sub_1', alias: 'rev', cli_type: 'codex', role: 'reviewer', status: 'running',
  native_session_id: 'native_1', cwd: '/repo', model: 'gpt-5', reasoning_effort: 'high',
  last_seen_at: ISO, raw_tail: 'line 2',
};
const MESSAGE = {
  id: 'msg_2', session_id: 'sess_1', from_peer_id: 'sub_1', to_peer_id: 'main',
  kind: 'sub_to_main', content: 'done', artifact_refs: null, created_at: ISO,
};
const CHOICE_ROW = {
  id: 'choice_1', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main',
  question: 'Which fix?', options_json: JSON.stringify([
    { id: 'safe', label: 'Safe', tradeoff: 'slower' }, { id: 'fast', label: 'Fast' },
  ]),
  recommendation_json: JSON.stringify({ option_id: 'safe', reason: 'bounded', confidence: 'high' }),
  status: 'pending_main_agent', selected: null, rationale: null, created_at: ISO, resolved_at: null,
};

let servers: FastifyInstance[] = [];
let databases: GatewayDb[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});

async function fakeCore(register: (app: FastifyInstance) => void): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify({ logger: false });
  register(app);
  servers.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, url: address };
}

function registerReadRoutes(app: FastifyInstance, requests: string[] = []): void {
  app.addHook('onRequest', (request, _reply, done) => { requests.push(request.url); done(); });
  app.get('/v1/health', async () => ({ ok: true, version: '0.1.0', db_ok: true }));
  app.get('/v1/sessions', async () => ({ sessions: [SESSION] }));
  app.get('/v1/sessions/:id/subagents', async () => ({ subagents: [SUBAGENT] }));
  app.get('/v1/sessions/:id/messages', async () => ({ messages: [MESSAGE] }));
  app.get('/v1/sessions/:id/choices', async () => ({ choices: [CHOICE_ROW] }));
  app.post('/v1/sessions/:id/choices/:choiceId/resolve', async () => ({ status: 'resolved' }));
}

function stalledResponseFetch(): { fetch: typeof globalThis.fetch; reading: Promise<void> } {
  let markReading!: () => void;
  const reading = new Promise<void>((resolve) => { markReading = resolve; });
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => controller.error(new DOMException('aborted', 'AbortError'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      },
      pull() {
        markReading();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, reading };
}

describe('Core URL policy', () => {
  it.each([
    ['http://127.0.0.1:28771/', 'http://127.0.0.1:28771'],
    ['http://localhost:28771', 'http://localhost:28771'],
    ['http://[::1]:28771/', 'http://[::1]:28771'],
  ])('accepts loopback HTTP URL %s', (input, expected) => {
    expect(parseCoreBaseUrl(input)).toBe(expected);
  });

  it.each([
    'https://127.0.0.1:28771', 'http://0.0.0.0:28771', 'http://example.com',
    'http://user:pass@localhost:28771', 'http://localhost:28771/v1',
    'http://localhost:28771/?x=1', 'http://localhost:28771/#x',
  ])('rejects unsafe Core URL %s', (input) => {
    expect(() => parseCoreBaseUrl(input)).toThrow('invalid_core_url');
  });
});

describe('CoreClient', () => {
  it('uses only the configured public routes, encodes path segments, and structures choice JSON', async () => {
    const requests: string[] = [];
    const { url } = await fakeCore((app) => registerReadRoutes(app, requests));
    const client = new CoreClient(url);

    await expect(client.health()).resolves.toEqual({ ok: true, version: '0.1.0', db_ok: true });
    await expect(client.listSessions()).resolves.toEqual([SESSION]);
    await expect(client.listSubagents('sess /?')).resolves.toEqual([SUBAGENT]);
    await expect(client.listMessages('sess /?', 25)).resolves.toEqual([MESSAGE]);
    await expect(client.listChoices('sess /?')).resolves.toEqual([{
      ...CHOICE_ROW,
      options: [{ id: 'safe', label: 'Safe', tradeoff: 'slower' }, { id: 'fast', label: 'Fast' }],
      recommendation: { option_id: 'safe', reason: 'bounded', confidence: 'high' },
      options_json: undefined,
      recommendation_json: undefined,
    }]);
    await client.resolveChoice('sess /?', 'choice /?', 'safe', 'bounded');

    expect(requests).toEqual([
      '/v1/health', '/v1/sessions', '/v1/sessions/sess%20%2F%3F/subagents',
      '/v1/sessions/sess%20%2F%3F/messages?limit=25',
      '/v1/sessions/sess%20%2F%3F/choices',
      '/v1/sessions/sess%20%2F%3F/choices/choice%20%2F%3F/resolve',
    ]);
  });

  it('reads a live debug bundle concurrently and persists none of its content', async () => {
    let active = 0;
    let maxActive = 0;
    const { url } = await fakeCore((app) => {
      registerReadRoutes(app);
      for (const path of ['subagents', 'messages', 'choices']) {
        app.addHook('preHandler', async (request) => {
          if (!request.url.endsWith(path)) return;
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        });
      }
    });
    const client = new CoreClient(url);
    const session = await client.getSessionDebug('sess_1');

    expect(session).toEqual({ session: SESSION, subagents: [SUBAGENT], messages: [MESSAGE], choices: [expect.objectContaining({ id: 'choice_1' })] });
    expect(maxActive).toBe(3);

    const db = openGatewayDb(':memory:');
    databases.push(db);
    expect(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE sql LIKE '%raw_tail%'").all()).toEqual([]);
    expect(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE sql LIKE '%root_task%' OR sql LIKE '%options_json%'").all()).toEqual([]);
  });

  it('normalizes timeout, invalid JSON, invalid schemas, non-2xx, and offline errors', async () => {
    const timeout = await fakeCore((app) => app.get('/v1/health', async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true, version: 'late', db_ok: true };
    }));
    await expect(new CoreClient(timeout.url, { timeoutMs: 20 }).health()).rejects.toMatchObject({ code: 'core_timeout', status: 504 });

    const invalidJson = await fakeCore((app) => app.get('/v1/sessions', async (_request, reply) => reply.type('application/json').send('{')));
    await expect(new CoreClient(invalidJson.url).listSessions()).rejects.toMatchObject({ code: 'core_protocol_error', status: 502 });

    const invalidSchema = await fakeCore((app) => app.get('/v1/health', async () => ({ ok: 'yes', version: 1, db_ok: true })));
    await expect(new CoreClient(invalidSchema.url).health()).rejects.toMatchObject({ code: 'core_protocol_error', status: 502 });

    const upstream = await fakeCore((app) => app.get('/v1/sessions', async (_request, reply) => reply.code(404).send({ error: { code: 'sensitive_code_canary', message: 'secret detail' } })));
    await expect(new CoreClient(upstream.url).listSessions()).rejects.toEqual(expect.objectContaining({
      code: 'core_upstream_error', status: 502, upstreamStatus: 404, message: 'Core request failed',
    }));

    const closed = await fakeCore((app) => app.get('/v1/health', async () => ({ ok: true, version: 'x', db_ok: true })));
    await closed.app.close();
    servers = servers.filter((server) => server !== closed.app);
    await expect(new CoreClient(closed.url).health()).rejects.toMatchObject({ code: 'core_offline', status: 503 });
  });

  it('uses a composed 2-second timeout for ordinary reads', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const pending = new CoreClient('http://127.0.0.1:28771', { fetch: fetchFn }).health();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'core_timeout', status: 504 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('classifies an internal timeout while reading a stalled response body', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponseFetch();
    const pending = new CoreClient('http://127.0.0.1:28771', { fetch: stalled.fetch }).health();
    await stalled.reading;

    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toMatchObject({ code: 'core_timeout', status: 504 });
  });

  it('classifies a caller abort while reading a stalled response body', async () => {
    const stalled = stalledResponseFetch();
    const controller = new AbortController();
    const pending = new CoreClient('http://127.0.0.1:28771', { fetch: stalled.fetch }).health(controller.signal);
    await stalled.reading;

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'core_request_aborted', status: 499 });
  });

  it('rejects malformed structured choice JSON at the client boundary', async () => {
    const { url } = await fakeCore((app) => app.get('/v1/sessions/:id/choices', async () => ({ choices: [{ ...CHOICE_ROW, options_json: '{' }] })));
    await expect(new CoreClient(url).listChoices('sess_1')).rejects.toMatchObject({ code: 'core_protocol_error', status: 502 });
  });

  it('parses hello and event SSE frames split across chunks', async () => {
    const { url } = await fakeCore((app) => app.get('/v1/events', async (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.write('data: {"type":"hello",');
      reply.raw.write('"payload":{}}\n\n');
      reply.raw.end('data: {"type":"subagent_status","payload":{"session_id":"sess_1"}}\n\n');
    }));
    const controller = new AbortController();
    const events = [];
    for await (const event of new CoreClient(url).events(controller.signal)) events.push(event);
    expect(events).toEqual([
      { type: 'hello', payload: {} },
      { type: 'subagent_status', payload: { session_id: 'sess_1' } },
    ]);
  });

  it('merges the latest live SSE raw tail into the debug bundle', async () => {
    const liveTail = '{"type":"item.completed","item":{"text":"live line 3"}}';
    const { url } = await fakeCore((app) => {
      registerReadRoutes(app);
      app.get('/v1/events', async (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
        reply.raw.end(`data: ${JSON.stringify({
          type: 'subagent_output',
          payload: {
            session_id: 'sess_1',
            subagent_id: 'sub_1',
            raw_tail: liveTail,
          },
        })}\n\n`);
      });
    });
    const client = new CoreClient(url);
    const controller = new AbortController();

    for await (const _event of client.events(controller.signal)) {
      // Consume the event stream so the client observes the live tail.
    }

    const debug = await client.getSessionDebug('sess_1');
    expect(debug.subagents[0]?.raw_tail).toBe(liveTail);
  });
});

describe('CoreConnectionRepository', () => {
  it('stores only URL, version, status, and health timestamps', () => {
    const db = openGatewayDb(':memory:');
    databases.push(db);
    const repository = new CoreConnectionRepository(db, () => ISO);

    repository.update('http://localhost:28771/');
    expect(repository.markHealth({ ok: true, version: '0.2.0', db_ok: true })).toEqual({
      baseUrl: 'http://localhost:28771', status: 'online', version: '0.2.0', lastCheckedAt: ISO,
    });
    expect(Object.keys(repository.get()).sort()).toEqual(['baseUrl', 'lastCheckedAt', 'status', 'version']);
    expect(repository.markHealth(undefined).status).toBe('offline');
  });
});
