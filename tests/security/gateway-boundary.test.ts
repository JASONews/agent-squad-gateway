import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { resolveGatewayConfig, type GatewayConfig } from '../../src/config/config.js';
import { ClientRepository } from '../../src/control-plane/clients.js';
import { CoreConnectionRepository } from '../../src/control-plane/core-connection.js';
import { CredentialService } from '../../src/control-plane/credentials.js';
import { openGatewayDb, type GatewayDb } from '../../src/control-plane/db.js';
import { ExtensionRepository } from '../../src/control-plane/extensions.js';
import { GrantRepository } from '../../src/control-plane/grants.js';
import { ResponseSessionRepository } from '../../src/control-plane/response-sessions.js';
import { RunRepository } from '../../src/control-plane/runs.js';
import { TargetRepository } from '../../src/control-plane/targets.js';
import {
  FakeProviderAdapter,
  type FakeProviderAdapterOptions,
} from '../../src/provider-runtime/fake/adapter.js';
import { InvocationService } from '../../src/provider-runtime/invocation-service.js';
import { ProviderRegistry } from '../../src/provider-runtime/registry.js';
import { TargetScheduler } from '../../src/provider-runtime/scheduler.js';
import type { ProviderRequest, ProviderResumeRequest } from '../../src/provider-runtime/types.js';
import { WorkspaceManager } from '../../src/provider-runtime/workspaces.js';
import { AdminAuthService } from '../../src/security/admin-auth.js';
import { buildGatewayApp } from '../../src/server/app.js';

const MODEL = 'metadata-boundary-model';
const ISO = '2026-07-13T12:00:00.000Z';
const CAPABILITIES = {
  isolationLevel: 'strict' as const,
  streamingMode: 'native' as const,
  toolBridge: 'structured_output' as const,
  resume: true,
  cancellation: true,
  modelSelection: true,
  effortSelection: true,
};
const RUN_METADATA_KEYS = [
  'clientId',
  'completedAt',
  'endpoint',
  'errorCode',
  'extensionId',
  'id',
  'latencyMs',
  'nativeSessionId',
  'queuedAt',
  'responseId',
  'startedAt',
  'status',
  'targetId',
].sort();

interface CreatedCredential {
  id: string;
  apiKey: string;
}

interface GatewayHarness {
  app: FastifyInstance;
  baseUrl: string;
  credentials: CredentialService;
  db: GatewayDb;
  providerStarts: ProviderRequest[];
  providerResumes: ProviderResumeRequest[];
  seededCredential?: CreatedCredential;
}

interface JsonResponse {
  response: Response;
  body: Record<string, unknown>;
}

function canary(label: string): string {
  return `gateway-boundary-${label}-${randomUUID()}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function requestJson(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return {
    response,
    body: await response.json() as Record<string, unknown>,
  };
}

async function openAIRequest(
  baseUrl: string,
  path: '/v1/chat/completions' | '/v1/responses',
  apiKey: string,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<JsonResponse> {
  return requestJson(baseUrl, path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

async function startHarness(
  config: GatewayConfig,
  masterKey: Buffer,
  adminSecret: Buffer,
  providerOptions: FakeProviderAdapterOptions,
  seed: boolean,
): Promise<GatewayHarness> {
  const db = openGatewayDb(config.paths.dbPath);
  const clients = new ClientRepository(db);
  const credentials = new CredentialService(db, masterKey);
  const extensions = new ExtensionRepository(db);
  const grants = new GrantRepository(db);
  const targets = new TargetRepository(db);
  const runs = new RunRepository(db);
  new CoreConnectionRepository(db).update(config.coreUrl);

  let seededCredential: CreatedCredential | undefined;
  if (seed) {
    const client = clients.create('boundary-client');
    const credential = credentials.create(client.id, 'boundary-authorization');
    seededCredential = { id: credential.id, apiKey: credential.apiKey };
    extensions.upsert('openai', '1.0.0', true);
    targets.create({
      id: MODEL,
      aliases: [],
      cli: 'fake',
      nativeModel: 'fake',
      reasoningEffort: 'medium',
      isolationLevel: 'strict',
      streamingMode: 'native',
      toolBridge: 'structured_output',
      maxConcurrency: 1,
      maxQueue: 8,
      queueTimeoutMs: 300_000,
      runTimeoutMs: null,
    });
    targets.setCapability(MODEL, {
      version: '1.0.0',
      verifiedAt: ISO,
      capabilities: CAPABILITIES,
    });
    targets.update(MODEL, { enabled: true });
    grants.grant(client.id, 'openai', MODEL);
  }

  const provider = new FakeProviderAdapter(providerOptions);
  const providerStarts: ProviderRequest[] = [];
  const providerResumes: ProviderResumeRequest[] = [];
  const start = provider.start.bind(provider);
  const resume = provider.resume.bind(provider);
  provider.start = (request) => {
    providerStarts.push(request);
    return start(request);
  };
  provider.resume = (request) => {
    providerResumes.push(request);
    return resume(request);
  };

  const providers = new ProviderRegistry();
  providers.register('fake', provider);
  const responseSessions = new ResponseSessionRepository(db);
  const responseWorkspaces = new WorkspaceManager(config.paths.workspacesDir, {
    getFixedWorkspaces: () => targets.list()
      .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
  });
  const invocationService = new InvocationService(
    providers,
    new TargetScheduler(),
    responseWorkspaces,
    targets,
    runs,
  );
  const app = buildGatewayApp({
    config,
    db,
    clients,
    credentials,
    extensions,
    grants,
    targets,
    runs,
    adminAuth: new AdminAuthService(db, adminSecret),
    invocationService,
    providers,
    responseSessions,
    responseWorkspaces,
  });

  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, baseUrl, credentials, db, providerStarts, providerResumes, seededCredential };
  } catch (error) {
    await app.close().catch(() => undefined);
    db.close();
    throw error;
  }
}

async function closeHarness(harness: GatewayHarness | undefined): Promise<void> {
  if (!harness) return;
  try {
    await harness.app.close();
  } finally {
    harness.db.close();
  }
}

function tableRowCounts(db: GatewayDb): Record<string, number> {
  const tables = db.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  return Object.fromEntries(tables.map(({ name }) => {
    const row = db.prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
    ).get();
    return [name, row!.count];
  }));
}

function regularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function expectNoCanariesInStateFiles(
  config: GatewayConfig,
  canaries: readonly string[],
): void {
  const excludedSecretFiles = new Set([
    resolve(config.paths.masterKeyPath),
    resolve(config.paths.adminSecretPath),
  ]);
  const inspected = regularFiles(config.paths.stateDir)
    .filter((path) => !excludedSecretFiles.has(resolve(path)));
  expect(inspected).toContain(config.paths.dbPath);
  for (const path of inspected) {
    const contents = readFileSync(path);
    for (const value of canaries) {
      expect(contents.includes(Buffer.from(value)), `${path} contains ${value}`).toBe(false);
    }
  }
}

function expectMetadataOnlyDatabase(
  dbPath: string,
  canaries: readonly string[],
  credential: CreatedCredential,
): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const credentialRow = db.prepare(
      'SELECT ciphertext, nonce, auth_tag FROM credentials WHERE id = ?',
    ).get(credential.id) as { ciphertext: string; nonce: string; auth_tag: string } | undefined;
    expect(credentialRow).toBeDefined();
    expect(credentialRow!.ciphertext).not.toBe(credential.apiKey);
    expect(Buffer.from(credentialRow!.ciphertext, 'base64url').toString('utf8'))
      .not.toBe(credential.apiKey);

    const tables = db.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const inspectedColumns: string[] = [];
    for (const { name: table } of tables) {
      const columns = db.prepare('SELECT name, type FROM pragma_table_xinfo(?)')
        .all(table) as Array<{ name: string; type: string }>;
      for (const column of columns) {
        const declaredType = column.type.toUpperCase();
        if (!declaredType.includes('TEXT') && !declaredType.includes('BLOB')) continue;
        inspectedColumns.push(`${table}.${column.name}`);
        const values = db.prepare(`
          SELECT ${quoteIdentifier(column.name)} AS value
          FROM ${quoteIdentifier(table)}
          WHERE ${quoteIdentifier(column.name)} IS NOT NULL
        `).all() as Array<{ value: string | Buffer }>;
        for (const { value } of values) {
          const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
          for (const canaryValue of canaries) {
            expect(
              bytes.includes(Buffer.from(canaryValue)),
              `${table}.${column.name} contains ${canaryValue}`,
            ).toBe(false);
          }
        }
      }
    }
    expect(inspectedColumns).toContain('credentials.ciphertext');
    expect(inspectedColumns).toContain('runs.error_code');
    expect(inspectedColumns.length).toBeGreaterThan(0);
  } finally {
    db.close();
  }
}

it('enforces the Gateway metadata-only persistence boundary across runtime paths and restart', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'asq-gateway-boundary-'));
  const masterKey = randomBytes(32);
  const adminSecretBytes = randomBytes(32);
  const adminSecretCanary = adminSecretBytes.toString('base64url');
  const promptCanary = canary('prompt');
  const completionCanary = canary('completion');
  const functionArgsCanary = canary('function-args');
  const functionResultCanary = canary('function-result');
  const nativeRawCanary = canary('native-raw-output');
  const idempotencyKey = canary('idempotency');
  const providerOptions: FakeProviderAdapterOptions = { chunks: [completionCanary] };
  let core: FastifyInstance | undefined;
  let gateway: GatewayHarness | undefined;
  let credential: CreatedCredential | undefined;

  try {
    core = Fastify({ logger: false });
    const coreRequests: string[] = [];
    core.addHook('preHandler', (request, _reply, done) => {
      coreRequests.push(request.url);
      done();
    });
    core.get('/v1/sessions', async () => ({
      sessions: [{
        id: 'boundary-session',
        root_task: 'Boundary inspection',
        repo_path: '/boundary',
        main_peer_id: 'main',
        created_at: ISO,
        updated_at: ISO,
      }],
    }));
    core.get('/v1/sessions/:id/subagents', async () => ({
      subagents: [{
        id: 'boundary-subagent',
        alias: 'fake',
        cli_type: 'fake',
        role: 'worker',
        status: 'completed',
        native_session_id: 'native-boundary-session',
        cwd: '/boundary',
        model: 'fake',
        reasoning_effort: 'medium',
        last_seen_at: ISO,
        raw_tail: nativeRawCanary,
      }],
    }));
    core.get('/v1/sessions/:id/messages', async () => ({ messages: [] }));
    core.get('/v1/sessions/:id/choices', async () => ({ choices: [] }));
    const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });

    const config = resolveGatewayConfig({ baseDir, coreUrl, port: 0, webUiAuth: 'token' });
    mkdirSync(config.paths.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(config.paths.masterKeyPath, masterKey, { mode: 0o600 });
    writeFileSync(config.paths.adminSecretPath, adminSecretBytes, { mode: 0o600 });
    gateway = await startHarness(config, masterKey, adminSecretBytes, providerOptions, true);
    credential = gateway.seededCredential!;
    const authorizationCanary = credential.apiKey;
    const plaintextCanaries = [
      authorizationCanary,
      promptCanary,
      completionCanary,
      functionArgsCanary,
      functionResultCanary,
      nativeRawCanary,
      adminSecretCanary,
    ];

    const chatPayload = {
      model: MODEL,
      messages: [{ role: 'user', content: promptCanary }],
    };
    const chat = await openAIRequest(
      gateway.baseUrl,
      '/v1/chat/completions',
      authorizationCanary,
      chatPayload,
      { 'idempotency-key': idempotencyKey },
    );
    expect(chat.response.status).toBe(200);
    const chatChoices = chat.body.choices as Array<{
      message: { content: string | null };
    }>;
    expect(chatChoices[0]?.message.content).toBe(completionCanary);
    expect(gateway.providerStarts).toHaveLength(1);
    expect(gateway.providerStarts[0]!.input).toEqual([
      { role: 'user', content: promptCanary },
    ]);
    expect(gateway.db.prepare<[string], { last_used_at: string | null }>(
      'SELECT last_used_at FROM credentials WHERE id = ?',
    ).get(credential.id)?.last_used_at).toEqual(expect.any(String));
    expect(gateway.credentials.reveal(credential.id)).toBe(authorizationCanary);

    const tools = [{
      type: 'function',
      name: 'boundary_tool',
      strict: true,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { marker: { type: 'string' } },
        required: ['marker'],
      },
    }];
    providerOptions.structuredEnvelope = {
      type: 'tool_calls',
      tool_calls: [{ name: 'boundary_tool', arguments: { marker: functionArgsCanary } }],
    };
    const toolRequest = await openAIRequest(
      gateway.baseUrl,
      '/v1/responses',
      authorizationCanary,
      { model: MODEL, input: 'Invoke the boundary tool.', tools, tool_choice: 'required' },
    );
    expect(toolRequest.response.status).toBe(200);
    const toolOutput = toolRequest.body.output as Array<{
      type: string;
      call_id: string;
      arguments: string;
    }>;
    const functionCall = toolOutput.find((item) => item.type === 'function_call');
    expect(functionCall).toBeDefined();
    expect(JSON.parse(functionCall!.arguments)).toEqual({ marker: functionArgsCanary });
    expect(gateway.providerStarts.at(-1)!.input).toEqual([
      { role: 'user', content: 'Invoke the boundary tool.' },
    ]);

    providerOptions.structuredEnvelope = {
      type: 'assistant_text',
      content: 'Boundary tool completed.',
    };
    const toolResult = await openAIRequest(
      gateway.baseUrl,
      '/v1/responses',
      authorizationCanary,
      {
        model: MODEL,
        previous_response_id: toolRequest.body.id,
        input: [{
          type: 'function_call_output',
          call_id: functionCall!.call_id,
          output: functionResultCanary,
        }],
        tools,
      },
    );
    expect(toolResult.response.status).toBe(200);
    expect(toolResult.body.output_text).toBe('Boundary tool completed.');
    expect(gateway.providerResumes).toHaveLength(1);
    expect(gateway.providerResumes[0]!.input).toEqual([{
      role: 'tool',
      toolCallId: functionCall!.call_id,
      content: functionResultCanary,
    }]);

    providerOptions.failAfterSession = true;
    const failed = await openAIRequest(
      gateway.baseUrl,
      '/v1/chat/completions',
      authorizationCanary,
      { model: MODEL, messages: [{ role: 'user', content: 'Fail with normalized metadata.' }] },
    );
    providerOptions.failAfterSession = false;
    expect(failed.response.status).toBe(502);
    expect(failed.body).toEqual({
      error: {
        message: 'The provider could not complete the request',
        type: 'server_error',
        param: null,
        code: 'provider_error',
      },
    });

    const mint = await requestJson(gateway.baseUrl, '/admin/bootstrap/mint', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSecretCanary}` },
    });
    expect(mint.response.status).toBe(200);
    expect(mint.body.code).toEqual(expect.any(String));
    const exchange = await requestJson(gateway.baseUrl, '/admin/bootstrap/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: mint.body.code }),
    });
    expect(exchange.response.status).toBe(200);
    const cookie = exchange.response.headers.get('set-cookie')!.split(';', 1)[0]!;
    const adminHeaders = {
      cookie,
      origin: 'http://127.0.0.1:0',
      'x-csrf-token': exchange.body.csrf_token as string,
    };

    const runLog = await requestJson(gateway.baseUrl, '/admin/runs', { headers: adminHeaders });
    expect(runLog.response.status).toBe(200);
    const loggedRuns = runLog.body.runs as Array<Record<string, unknown>>;
    expect(loggedRuns.length).toBeGreaterThanOrEqual(4);
    for (const run of loggedRuns) expect(Object.keys(run).sort()).toEqual(RUN_METADATA_KEYS);
    expect(loggedRuns).toContainEqual(expect.objectContaining({
      status: 'failed',
      errorCode: 'fake_failed_after_session',
    }));
    const serializedRunLog = JSON.stringify(runLog.body);
    for (const value of plaintextCanaries) expect(serializedRunLog).not.toContain(value);
    expect(serializedRunLog).not.toMatch(/"(?:prompt|completion|raw_tail|payload)"/i);

    const rowsBeforeDebug = tableRowCounts(gateway.db);
    const debug = await requestJson(
      gateway.baseUrl,
      '/admin/core/sessions/boundary-session/debug',
      { headers: adminHeaders },
    );
    expect(debug.response.status).toBe(200);
    const debugSubagents = debug.body.subagents as Array<{ raw_tail: string | null }>;
    expect(debugSubagents[0]?.raw_tail).toBe(nativeRawCanary);
    expect(coreRequests).toEqual(expect.arrayContaining([
      '/v1/sessions',
      '/v1/sessions/boundary-session/subagents',
      '/v1/sessions/boundary-session/messages',
      '/v1/sessions/boundary-session/choices',
    ]));
    expect(tableRowCounts(gateway.db)).toEqual(rowsBeforeDebug);

    await closeHarness(gateway);
    gateway = undefined;
    expectNoCanariesInStateFiles(config, plaintextCanaries);
    expectMetadataOnlyDatabase(config.paths.dbPath, plaintextCanaries, credential);

    gateway = await startHarness(config, masterKey, adminSecretBytes, providerOptions, false);
    const replay = await openAIRequest(
      gateway.baseUrl,
      '/v1/chat/completions',
      authorizationCanary,
      chatPayload,
      { 'idempotency-key': idempotencyKey },
    );
    expect(replay.response.status).toBe(409);
    expect(replay.body).toEqual({
      error: {
        message: 'Idempotency replay is unavailable',
        type: 'invalid_request_error',
        param: null,
        code: 'idempotency_replay_unavailable',
      },
    });
    expect(JSON.stringify(replay.body)).not.toContain(completionCanary);
    expect(gateway.providerStarts).toHaveLength(0);
    expect(gateway.providerResumes).toHaveLength(0);

    await closeHarness(gateway);
    gateway = undefined;
    expectNoCanariesInStateFiles(config, plaintextCanaries);
    expectMetadataOnlyDatabase(config.paths.dbPath, plaintextCanaries, credential);
  } finally {
    await closeHarness(gateway).catch(() => undefined);
    await core?.close().catch(() => undefined);
    rmSync(baseDir, { recursive: true, force: true });
  }
});
