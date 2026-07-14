import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolveGatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CoreConnectionRepository } from '../../src/control-plane/core-connection.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import { CapabilityService } from '../../src/provider-runtime/capability-service.js';
import { FakeProviderAdapter } from '../../src/provider-runtime/fake/adapter.js';
import { InvocationService } from '../../src/provider-runtime/invocation-service.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';
import type { ProviderCapabilities, ProviderProbeRequest } from '../../src/provider-runtime/types.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../src/server/app.js';

const HOST = '127.0.0.1';
const ISO = '2026-07-13T12:00:00.000Z';
const ADMIN_SECRET = Buffer.alloc(32, 9);
const TARGET_ID = 'browser-fake-target';
const PRIMARY_SESSION_ID = 'sess_browser_primary';
const RUN_ID = 'run_browser_cancellable';
const LONG_TOKEN = `unbroken-${'gateway'.repeat(10)}`;

interface CoreSession {
  id: string;
  root_task: string;
  repo_path: string | null;
  main_peer_id: string | null;
  created_at: string;
  updated_at: string;
}

interface CoreChoice {
  id: string;
  session_id: string;
  requester_subagent_id: string;
  target_peer_id: string | null;
  question: string;
  options_json: string;
  recommendation_json: string | null;
  status: 'pending_main_agent' | 'resolved';
  selected: string | null;
  rationale: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface AdminSession {
  csrfToken: string;
  cookie: { name: string; value: string };
}

export interface GatewaySeed {
  apiKey: string;
  clientId: string;
  clientName: string;
  primaryChoiceQuestion: string;
  primarySessionId: string;
  rootTask: string;
  runId: string;
  targetId: string;
}

class BrowserFakeProvider extends FakeProviderAdapter {
  conformanceProbeCount = 0;

  override async probeCapabilities(request?: ProviderProbeRequest): Promise<ProviderCapabilities> {
    const capabilities = await super.probeCapabilities(request);
    if (request?.mode === 'conformance') this.conformanceProbeCount += 1;
    return {
      ...capabilities,
      version: 'browser-fake-1.0.0',
      verified: request?.mode === 'conformance',
      ...(request?.mode === 'conformance' ? { verifiedAt: ISO } : {}),
    };
  }
}

export class FakeCore {
  readonly primaryChoiceQuestion = `Which bounded strategy should handle ${LONG_TOKEN}?`;
  readonly rootTask = 'Gateway browser hardening with deterministic fixtures, offline recovery, keyboard focus, and responsive overflow coverage';
  private app: FastifyInstance | undefined;
  private port = 0;
  private readonly eventClients = new Set<NodeJS.WritableStream>();
  private readonly sessions: CoreSession[] = [{
    id: PRIMARY_SESSION_ID,
    root_task: this.rootTask,
    repo_path: '/workspace/browser/fixtures/core/session/primary',
    main_peer_id: 'main',
    created_at: ISO,
    updated_at: ISO,
  }];
  private readonly choices: CoreChoice[] = [
    {
      id: 'choice_browser_strategy',
      session_id: PRIMARY_SESSION_ID,
      requester_subagent_id: 'sub_browser_reviewer',
      target_peer_id: 'main',
      question: this.primaryChoiceQuestion,
      options_json: JSON.stringify([
        { id: 'safe', label: 'Bounded rollout', tradeoff: 'Slower, with explicit checkpoints.' },
        { id: 'fast', label: 'Immediate rollout', tradeoff: 'Faster, with more operational risk.' },
        { id: 'balanced', label: 'Staged rollout', tradeoff: 'Moderate speed and observability.' },
      ]),
      recommendation_json: JSON.stringify({
        option_id: 'safe',
        reason: 'The bounded path preserves deterministic recovery.',
        confidence: 'high',
      }),
      status: 'pending_main_agent',
      selected: null,
      rationale: null,
      created_at: ISO,
      resolved_at: null,
    },
    {
      id: 'choice_browser_followup',
      session_id: PRIMARY_SESSION_ID,
      requester_subagent_id: 'sub_browser_reviewer',
      target_peer_id: 'main',
      question: 'Which follow-up window?',
      options_json: JSON.stringify([
        { id: 'today', label: 'Today' },
        { id: 'tomorrow', label: 'Tomorrow' },
      ]),
      recommendation_json: null,
      status: 'pending_main_agent',
      selected: null,
      rationale: null,
      created_at: ISO,
      resolved_at: null,
    },
  ];

  get baseURL(): string {
    if (this.port === 0) throw new Error('fake_core_not_started');
    return `http://${HOST}:${this.port}`;
  }

  get resolvedPrimaryChoice(): Pick<CoreChoice, 'selected' | 'rationale'> {
    const choice = this.choices.find((candidate) => candidate.id === 'choice_browser_strategy');
    return { selected: choice?.selected ?? null, rationale: choice?.rationale ?? null };
  }

  async start(): Promise<void> {
    if (this.app) return;
    const app = Fastify({ logger: false });
    app.get('/v1/health', async () => ({ ok: true, version: 'browser-core-1', db_ok: true }));
    app.get('/v1/sessions', async () => ({ sessions: this.sessions }));
    app.get('/v1/sessions/:id/subagents', async (request) => {
      const { id } = request.params as { id: string };
      return { subagents: id === PRIMARY_SESSION_ID ? [{
        id: 'sub_browser_reviewer',
        alias: 'reviewer-with-an-intentionally-long-alias',
        cli_type: 'fake',
        role: 'reviewer',
        status: 'running',
        native_session_id: 'native-browser-session-id-0001',
        cwd: `/workspace/${LONG_TOKEN}`,
        model: 'fake',
        reasoning_effort: 'high',
        last_seen_at: ISO,
        raw_tail: `line one\n${LONG_TOKEN}\nline three`,
      }] : [] };
    });
    app.get('/v1/sessions/:id/messages', async (request) => {
      const { id } = request.params as { id: string };
      return { messages: id === PRIMARY_SESSION_ID ? [{
        id: 'msg_browser_long',
        session_id: PRIMARY_SESSION_ID,
        from_peer_id: 'sub_browser_reviewer',
        to_peer_id: 'main',
        kind: 'status',
        content: `Browser fixture update ${LONG_TOKEN}`,
        artifact_refs: null,
        created_at: ISO,
      }] : [] };
    });
    app.get('/v1/sessions/:id/choices', async (request) => {
      const { id } = request.params as { id: string };
      return { choices: this.choices.filter((choice) => choice.session_id === id) };
    });
    app.post('/v1/sessions/:id/choices/:choiceId/resolve', async (request) => {
      const { id, choiceId } = request.params as { id: string; choiceId: string };
      const body = request.body as { selected: string; rationale?: string };
      const choice = this.choices.find((candidate) => candidate.session_id === id && candidate.id === choiceId);
      if (choice?.status === 'pending_main_agent') {
        choice.status = 'resolved';
        choice.selected = body.selected;
        choice.rationale = body.rationale ?? null;
        choice.resolved_at = ISO;
      }
      return { status: 'resolved' };
    });
    app.get('/v1/events', async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream',
      });
      this.eventClients.add(reply.raw);
      request.raw.once('close', () => this.eventClients.delete(reply.raw));
      reply.raw.write('data: {"type":"hello","payload":{}}\n\n');
    });
    this.app = app;
    try {
      await app.listen({ host: HOST, port: this.port });
      this.port = (app.server.address() as AddressInfo).port;
    } catch (error) {
      this.app = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    if (!app) return;
    this.app = undefined;
    for (const client of this.eventClients) client.end();
    this.eventClients.clear();
    await app.close();
  }

  async setOnline(online: boolean): Promise<void> {
    if (online) await this.start();
    else await this.stop();
  }

  addSseSession(): CoreSession {
    const session = {
      id: 'sess_browser_sse',
      root_task: 'Session delivered through a Core SSE invalidation',
      repo_path: '/workspace/sse',
      main_peer_id: 'main',
      created_at: ISO,
      updated_at: '2026-07-13T12:01:00.000Z',
    };
    if (!this.sessions.some((candidate) => candidate.id === session.id)) this.sessions.push(session);
    return session;
  }

  emitSessionUpdate(sessionId: string): void {
    const wire = `data: ${JSON.stringify({ type: 'session_update', payload: { session_id: sessionId } })}\n\n`;
    for (const client of this.eventClients) client.write(wire);
  }
}

export interface GatewayHarness {
  baseURL: string;
  core: FakeCore;
  seed: GatewaySeed;
  conformanceProbeCount(): number;
  createAdminSession(): Promise<AdminSession>;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startGatewayHarness(): Promise<{ harness: GatewayHarness; close(): Promise<void> }> {
  const baseDir = mkdtempSync(join(tmpdir(), 'agent-squad-gateway-browser-'));
  const core = new FakeCore();
  await core.start();
  const port = await reservePort();
  const config = resolveGatewayConfig({
    baseDir,
    coreUrl: core.baseURL,
    port,
    webUiAuth: 'token',
  });
  mkdirSync(config.paths.stateDir, { recursive: true });
  const db = openGatewayDb(config.paths.dbPath);
  const clients = new ClientRepository(db);
  const credentials = new CredentialService(db, Buffer.alloc(32, 5));
  const targets = new TargetRepository(db);
  const grants = new GrantRepository(db);
  const extensions = new ExtensionRepository(db);
  const runs = new RunRepository(db);
  const coreConnection = new CoreConnectionRepository(db);
  coreConnection.update(core.baseURL);
  const provider = new BrowserFakeProvider({ chunks: ['browser ', 'response'] });
  const providers = new ProviderRegistry();
  providers.register('fake', provider);
  const workspaces = new WorkspaceManager(config.paths.workspacesDir, {
    getFixedWorkspaces: () => targets.list()
      .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
  });
  const capabilityService = new CapabilityService(providers, targets, workspaces);
  const invocationService = new InvocationService(
    providers,
    new TargetScheduler(),
    workspaces,
    targets,
    runs,
  );

  const clientName = `Browser client ${LONG_TOKEN}`;
  const client = clients.create(clientName);
  const credential = credentials.create(client.id, 'Browser primary key');
  extensions.upsert('openai', '1.0.0', true);
  targets.create({
    id: TARGET_ID,
    aliases: ['browser-fake-alias'],
    cli: 'fake',
    nativeModel: 'fake',
    reasoningEffort: 'high',
    isolationLevel: 'strict',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    maxConcurrency: 1,
    maxQueue: 4,
    queueTimeoutMs: 30_000,
    runTimeoutMs: 60_000,
  });
  invocationService.cancel = async (runId: string) => {
    const activeRun = runs.get(runId);
    if (!activeRun || activeRun.status !== 'running') return false;
    runs.markFinished(runId, 'cancelled');
    return true;
  };

  const app = buildGatewayApp({
    config,
    db,
    clients,
    credentials,
    targets,
    grants,
    extensions,
    runs,
    adminAuth: new AdminAuthService(db, ADMIN_SECRET),
    providers,
    invocationService,
    responseWorkspaces: workspaces,
    capabilityService,
    coreConnection,
    scanCapabilitiesOnReady: true,
    coreEventProxyOptions: {
      heartbeatMs: 250,
      reconnectDelaysMs: [25, 50, 100],
    },
  });
  await app.listen({ host: HOST, port });
  const baseURL = `http://${HOST}:${port}`;
  const run = runs.create({
    clientId: client.id,
    extensionId: 'openai',
    targetId: TARGET_ID,
    endpoint: `/v1/responses/${LONG_TOKEN}`,
  }, RUN_ID);
  runs.markStarted(run.id, 'fake_browser_session');

  const createAdminSession = async (): Promise<AdminSession> => {
    const mint = await fetch(`${baseURL}/admin/bootstrap/mint`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_SECRET.toString('base64url')}` },
    });
    if (!mint.ok) throw new Error(`bootstrap_mint_failed_${mint.status}`);
    const { code } = await mint.json() as { code: string };
    const exchange = await fetch(`${baseURL}/admin/bootstrap/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!exchange.ok) throw new Error(`bootstrap_exchange_failed_${exchange.status}`);
    const cookieHeader = exchange.headers.get('set-cookie');
    if (!cookieHeader) throw new Error('bootstrap_cookie_missing');
    const [cookiePair] = cookieHeader.split(';', 1);
    const separator = cookiePair!.indexOf('=');
    const body = await exchange.json() as { csrf_token: string };
    return {
      csrfToken: body.csrf_token,
      cookie: {
        name: cookiePair!.slice(0, separator),
        value: cookiePair!.slice(separator + 1),
      },
    };
  };

  const harness: GatewayHarness = {
    baseURL,
    core,
    seed: {
      apiKey: credential.apiKey,
      clientId: client.id,
      clientName,
      primaryChoiceQuestion: core.primaryChoiceQuestion,
      primarySessionId: PRIMARY_SESSION_ID,
      rootTask: core.rootTask,
      runId: run.id,
      targetId: TARGET_ID,
    },
    conformanceProbeCount: () => provider.conformanceProbeCount,
    createAdminSession,
  };

  return {
    harness,
    async close() {
      const failures: unknown[] = [];
      try { await app.close(); } catch (error) { failures.push(error); }
      try { await core.stop(); } catch (error) { failures.push(error); }
      try { db.close(); } catch (error) { failures.push(error); }
      rmSync(baseDir, { recursive: true, force: true });
      if (failures.length > 0) throw new AggregateError(failures, 'browser fixture cleanup failed');
    },
  };
}

interface BrowserFixtures {
  gateway: GatewayHarness;
}

export const test = base.extend<{}, BrowserFixtures>({
  gateway: [async ({}, use) => {
    const runtime = await startGatewayHarness();
    try {
      await use(runtime.harness);
    } finally {
      await runtime.close();
    }
  }, { scope: 'worker' }],
  page: async ({ context, gateway }, use) => {
    const session = await gateway.createAdminSession();
    await context.addCookies([{
      ...session.cookie,
      url: gateway.baseURL,
      httpOnly: true,
      sameSite: 'Strict',
    }]);
    await context.addInitScript((csrfToken: string) => {
      if (!window.sessionStorage.getItem('asq_gateway_csrf')) {
        window.sessionStorage.setItem('asq_gateway_csrf', csrfToken);
      }
    }, session.csrfToken);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await use(page);
  },
});

export { expect };
