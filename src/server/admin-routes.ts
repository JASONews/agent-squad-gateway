import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import {
  formatGatewayAddress,
  gatewayBindPolicy,
  type GatewayConfig,
} from '../config/config.js';
import type { CoreClient } from '../core-client/client.js';
import type { ClientRepository } from '../control-plane/clients.js';
import type { CoreConnectionRepository } from '../control-plane/core-connection.js';
import type { CredentialService } from '../control-plane/credentials.js';
import type { GatewayDb } from '../control-plane/db.js';
import type { ExtensionRepository } from '../control-plane/extensions.js';
import type { GrantRepository } from '../control-plane/grants.js';
import type { RunRepository } from '../control-plane/runs.js';
import type { TargetRepository } from '../control-plane/targets.js';
import type { CapabilityService } from '../provider-runtime/capability-service.js';
import type { AdminAuthService } from '../security/admin-auth.js';
import { requireAdmin, sessionCookie } from './auth-hooks.js';
import { GatewayError } from './errors.js';

const noStore = { 'cache-control': 'no-store' };
const clearedSessionCookie = 'asq_gateway_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0';
const idParams = z.object({ id: z.string().min(1) }).strict();
const runStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
const optionalQueryString = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);
const optionalRunStatus = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.enum(runStatuses).optional(),
);
const runsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  status: optionalRunStatus,
  target_id: optionalQueryString,
  client_id: optionalQueryString,
}).strict();

const emptyBody = z.object({}).strict();
const verifyTargetBody = z.object({ confirm_model_usage: z.literal(true) }).strict();
const extensionToggleBody = z.object({ enabled: z.boolean() }).strict();
const createClientBody = z.object({ name: z.string().trim().min(1) }).strict();
const optionalExpiry = z.string().datetime({ offset: true }).nullable().optional();
const createCredentialBody = z.object({
  name: z.string().trim().min(1),
  expires_at: optionalExpiry,
}).strict();
const updateClientBody = z.object({ status: z.enum(['active', 'disabled']) }).strict();
const bootstrapExchangeBody = z.object({ code: z.string().min(1) }).strict();
const createGrantBody = z.object({
  client_id: z.string().min(1),
  extension_id: z.string().min(1),
  target_id: z.string().min(1),
}).strict();
const updateCoreBody = z.object({ base_url: z.string().min(1) }).strict();

function normalizedExpiry(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}
const targetFields = {
  aliases: z.array(z.string().min(1)),
  cli: z.string().trim().min(1),
  native_model: z.string().trim().min(1),
  reasoning_effort: z.string().trim().min(1).nullable(),
  enabled: z.boolean(),
  isolation_level: z.enum(['strict', 'best_effort']),
  streaming_mode: z.enum(['native', 'none']),
  tool_bridge: z.enum(['structured_output', 'none']),
  max_concurrency: z.number().int().positive(),
  max_queue: z.number().int().nonnegative(),
  queue_timeout_ms: z.number().int().positive(),
  run_timeout_ms: z.number().int().positive().nullable(),
  fixed_workspace: z.string().min(1).nullable(),
  acknowledge_fixed_workspace_downgrade: z.boolean(),
  enabled_best_effort: z.boolean(),
} as const;
const createTargetBody = z.object({
  id: z.string().min(1),
  aliases: targetFields.aliases.optional(),
  cli: targetFields.cli,
  native_model: targetFields.native_model,
  reasoning_effort: targetFields.reasoning_effort.optional(),
  isolation_level: targetFields.isolation_level.optional(),
  streaming_mode: targetFields.streaming_mode.optional(),
  tool_bridge: targetFields.tool_bridge.optional(),
  max_concurrency: targetFields.max_concurrency.optional(),
  max_queue: targetFields.max_queue.optional(),
  queue_timeout_ms: targetFields.queue_timeout_ms.optional(),
  run_timeout_ms: targetFields.run_timeout_ms.optional(),
  fixed_workspace: targetFields.fixed_workspace.optional(),
  acknowledge_fixed_workspace_downgrade: targetFields.acknowledge_fixed_workspace_downgrade.optional(),
  verify_on_create: z.boolean().optional(),
  confirm_model_usage: z.literal(true).optional(),
}).strict();
const updateTargetBody = z.object({
  aliases: targetFields.aliases.optional(),
  cli: targetFields.cli.optional(),
  native_model: targetFields.native_model.optional(),
  reasoning_effort: targetFields.reasoning_effort.optional(),
  enabled: targetFields.enabled.optional(),
  isolation_level: targetFields.isolation_level.optional(),
  streaming_mode: targetFields.streaming_mode.optional(),
  tool_bridge: targetFields.tool_bridge.optional(),
  max_concurrency: targetFields.max_concurrency.optional(),
  max_queue: targetFields.max_queue.optional(),
  queue_timeout_ms: targetFields.queue_timeout_ms.optional(),
  run_timeout_ms: targetFields.run_timeout_ms.optional(),
  fixed_workspace: targetFields.fixed_workspace.optional(),
  acknowledge_fixed_workspace_downgrade: targetFields.acknowledge_fixed_workspace_downgrade.optional(),
  enabled_best_effort: targetFields.enabled_best_effort.optional(),
}).strict();

interface AdminRouteDependencies {
  config: GatewayConfig;
  db: GatewayDb;
  clients: ClientRepository;
  coreClient: Pick<CoreClient, 'setBaseUrl'>;
  coreConnection: CoreConnectionRepository;
  credentials: CredentialService;
  targets: TargetRepository;
  grants: GrantRepository;
  extensions: ExtensionRepository;
  runs: RunRepository;
  adminAuth: AdminAuthService;
  trustedOrigins: ReadonlySet<string>;
  capabilityService?: CapabilityService;
  runCanceller?: { cancel(runId: string): Promise<boolean> };
  extensionManifests?: Array<{
    id: string;
    version: string;
    requiredGatewayVersion: string;
    endpoint: string;
  }>;
  extensionHealth?: () => Promise<Record<string, { ok: boolean; detail?: string }>>;
}

function parse<S extends ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) throw new GatewayError(400, 'validation_error', `invalid ${label}`);
    throw error;
  }
}

function body<S extends ZodType>(request: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, request.body ?? {}, 'request body');
}

function params(request: FastifyRequest): { id: string } {
  return parse(idParams, request.params, 'request path');
}

function query<S extends ZodType>(request: FastifyRequest, schema: S): z.infer<S> {
  return parse(schema, request.query, 'request query');
}

function knownError(error: unknown): never {
  const code = error instanceof Error ? error.message : '';
  const clientErrors = new Set([
    'client_name_exists', 'invalid_target_id', 'invalid_target_alias', 'invalid_target_cli',
    'invalid_native_model', 'invalid_reasoning_effort', 'invalid_isolation_level',
    'invalid_streaming_mode', 'invalid_tool_bridge', 'invalid_max_concurrency', 'invalid_max_queue',
    'invalid_queue_timeout', 'invalid_run_timeout', 'fixed_workspace_acknowledgement_required',
    'fixed_workspace_required_for_best_effort', 'fixed_workspace_must_be_absolute', 'fixed_workspace_not_found',
    'invalid_core_url',
  ]);
  const notFoundErrors = new Set([
    'client_not_found', 'credential_not_found', 'target_not_found', 'extension_not_found',
  ]);
  const conflictErrors = new Set([
    'target_id_exists', 'capability_verification_required', 'capability_mismatch',
    'best_effort_acknowledgement_required', 'target_enabled', 'target_in_use', 'client_in_use',
  ]);
  if (clientErrors.has(code)) throw new GatewayError(400, code, 'invalid control-plane request');
  if (notFoundErrors.has(code)) throw new GatewayError(404, code, 'control-plane resource not found');
  if (conflictErrors.has(code)) throw new GatewayError(409, code, 'control-plane state conflict');
  throw error;
}

function asTargetInput(input: z.infer<typeof createTargetBody>) {
  return {
    id: input.id,
    aliases: input.aliases,
    cli: input.cli,
    nativeModel: input.native_model,
    reasoningEffort: input.reasoning_effort,
    isolationLevel: input.isolation_level,
    streamingMode: input.streaming_mode,
    toolBridge: input.tool_bridge,
    maxConcurrency: input.max_concurrency,
    maxQueue: input.max_queue,
    queueTimeoutMs: input.queue_timeout_ms,
    runTimeoutMs: input.run_timeout_ms,
    fixedWorkspace: input.fixed_workspace,
    acknowledgeFixedWorkspaceDowngrade: input.acknowledge_fixed_workspace_downgrade,
  };
}

function asTargetPatch(input: z.infer<typeof updateTargetBody>) {
  return {
    aliases: input.aliases,
    cli: input.cli,
    nativeModel: input.native_model,
    reasoningEffort: input.reasoning_effort,
    enabled: input.enabled,
    isolationLevel: input.isolation_level,
    streamingMode: input.streaming_mode,
    toolBridge: input.tool_bridge,
    maxConcurrency: input.max_concurrency,
    maxQueue: input.max_queue,
    queueTimeoutMs: input.queue_timeout_ms,
    runTimeoutMs: input.run_timeout_ms,
    fixedWorkspace: input.fixed_workspace,
    acknowledgeFixedWorkspaceDowngrade: input.acknowledge_fixed_workspace_downgrade,
    enabledBestEffort: input.enabled_best_effort,
  };
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDependencies): void {
  const requireAuthenticatedAdmin = requireAdmin(
    deps.adminAuth,
    deps.trustedOrigins,
    deps.config.webUiAuth === 'token',
  );
  const capabilityService = (): CapabilityService => {
    if (!deps.capabilityService) {
      throw new GatewayError(503, 'capability_service_unavailable', 'capability service unavailable');
    }
    return deps.capabilityService;
  };

  app.get('/admin/auth/mode', async (_request, reply) => {
    return reply.headers(noStore).send({ mode: deps.config.webUiAuth });
  });

  app.get('/admin/settings', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const connection = deps.coreConnection.get();
    return reply.headers(noStore).send({
      core: {
        base_url: connection.baseUrl,
        status: connection.status,
        version: connection.version,
        last_checked_at: connection.lastCheckedAt,
      },
      bind_address: formatGatewayAddress(deps.config.host, deps.config.port),
      state_paths: {
        config: deps.config.paths.configPath,
        database: deps.config.paths.dbPath,
        master_key: deps.config.paths.masterKeyPath,
        admin_secret: deps.config.paths.adminSecretPath,
      },
      retention: { metadata_days: 30, replay_ttl_minutes: 10 },
      security: {
        bind: gatewayBindPolicy(deps.config.host),
        cors: 'disabled',
        web_ui_auth: deps.config.webUiAuth,
      },
    });
  });

  app.patch('/admin/settings/core', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, updateCoreBody);
    try {
      const connection = deps.coreConnection.update(input.base_url);
      deps.coreClient.setBaseUrl(connection.baseUrl);
      deps.config.coreUrl = connection.baseUrl;
      return reply.headers(noStore).send({ base_url: connection.baseUrl });
    } catch (error) {
      return knownError(error);
    }
  });

  app.get('/admin/setup/status', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const connection = deps.coreConnection.get();
    return reply.headers(noStore).send({
      core_configured: connection.lastCheckedAt !== null,
      cli_scan_complete: capabilityService().listAvailability().length > 0,
      target_count: deps.targets.list().length,
      client_count: deps.clients.list().length,
      credential_count: deps.credentials.list().length,
    });
  });

  app.post('/admin/setup/client-credential', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, createClientBody);
    try {
      const createClientAndCredential = deps.db.transaction(() => {
        const client = deps.clients.create(input.name);
        const credential = deps.credentials.create(client.id, input.name);
        return { client, credential };
      });
      const { credential } = createClientAndCredential();
      return reply.code(201).headers(noStore).send({
        id: credential.id,
        clientId: credential.clientId,
        prefix: credential.prefix,
        api_key: credential.apiKey,
      });
    } catch (error) {
      return knownError(error);
    }
  });

  app.post('/admin/bootstrap/mint', async (request, reply) => {
    body(request, emptyBody);
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      throw new GatewayError(401, 'admin_secret_required', 'admin secret required');
    }
    try {
      const code = deps.adminAuth.mintBootstrapCode(authorization.slice('Bearer '.length));
      return reply.headers(noStore).send({ code });
    } catch (error) {
      if (error instanceof Error && error.message === 'admin_secret_invalid') {
        throw new GatewayError(401, 'admin_secret_invalid', 'admin secret invalid');
      }
      throw error;
    }
  });

  app.post('/admin/bootstrap/exchange', async (request, reply) => {
    const input = body(request, bootstrapExchangeBody);
    try {
      const login = deps.adminAuth.exchange(input.code);
      return reply.headers(noStore).header('set-cookie', login.cookie).send({
        csrf_token: login.csrfToken,
        expires_at: login.expiresAt,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'bootstrap_code_invalid') {
        throw new GatewayError(401, 'bootstrap_code_invalid', 'bootstrap code invalid');
      }
      throw error;
    }
  });

  app.post('/admin/session/csrf', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    body(request, emptyBody);
    const token = sessionCookie(request.headers.cookie);
    const csrfToken = request.headers['x-csrf-token'];
    if (!token || typeof csrfToken !== 'string') throw new Error('authenticated admin context missing');

    let csrf: ReturnType<AdminAuthService['rotateCsrf']>;
    try {
      csrf = deps.adminAuth.rotateCsrf(token, csrfToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'admin_session_invalid') {
        throw new GatewayError(403, 'csrf_invalid', 'CSRF validation failed');
      }
      throw error;
    }
    return reply.headers(noStore).send({
      csrf_token: csrf.csrfToken,
      expires_at: csrf.expiresAt,
    });
  });

  app.post(
    '/admin/session/logout',
    { preHandler: requireAuthenticatedAdmin },
    async (request, reply) => {
      body(request, emptyBody);
      const token = sessionCookie(request.headers.cookie);
      if (token) deps.adminAuth.revokeSession(token);
      return reply
        .code(204)
        .headers(noStore)
        .header('set-cookie', clearedSessionCookie)
        .send();
    },
  );

  app.post('/admin/clients', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, createClientBody);
    try {
      return reply.code(201).send(deps.clients.create(input.name));
    } catch (error) {
      return knownError(error);
    }
  });

  app.get('/admin/clients', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const credentials = deps.credentials.list();
    return reply.send({
      clients: deps.clients.list().map((client) => {
        const clientCredentials = credentials.filter((credential) => credential.clientId === client.id);
        const lastUsedAt = clientCredentials.reduce<string | null>((latest, credential) =>
          credential.lastUsedAt !== null && (latest === null || credential.lastUsedAt > latest)
            ? credential.lastUsedAt
            : latest, null);
        return {
          ...client,
          credentialCount: clientCredentials.length,
          grantCount: deps.grants.listForClient(client.id).length,
          lastUsedAt,
        };
      }),
    });
  });

  app.get('/admin/clients/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const client = deps.clients.list().find((candidate) => candidate.id === id);
    if (!client) return knownError(new Error('client_not_found'));
    return reply.send({
      client,
      credentials: deps.credentials.list(id),
      grants: deps.grants.listForClient(id),
    });
  });

  app.patch('/admin/clients/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, updateClientBody);
    try {
      deps.clients.setStatus(id, input.status);
      const client = deps.clients.list().find((candidate) => candidate.id === id);
      return reply.send(client);
    } catch (error) {
      return knownError(error);
    }
  });

  app.delete('/admin/clients/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    body(request, emptyBody);
    try {
      deps.clients.delete(id);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error);
    }
  });

  app.post('/admin/clients/:id/credentials', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, createCredentialBody);
    try {
      const credential = deps.credentials.create(id, input.name, normalizedExpiry(input.expires_at));
      return reply.code(201).headers(noStore).send({
        id: credential.id,
        clientId: credential.clientId,
        prefix: credential.prefix,
        api_key: credential.apiKey,
      });
    } catch (error) {
      return knownError(error);
    }
  });

  app.get('/admin/credentials/:id/reveal', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    try {
      return reply.headers(noStore).send({ api_key: deps.credentials.reveal(id) });
    } catch (error) {
      return knownError(error);
    }
  });

  app.post('/admin/credentials/:id/rotate', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, createCredentialBody);
    try {
      const credential = deps.credentials.rotate(id, input.name, normalizedExpiry(input.expires_at));
      return reply.code(201).headers(noStore).send({
        id: credential.id,
        clientId: credential.clientId,
        prefix: credential.prefix,
        api_key: credential.apiKey,
      });
    } catch (error) {
      return knownError(error);
    }
  });

  app.post('/admin/credentials/:id/revoke', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    body(request, emptyBody);
    try {
      deps.credentials.revoke(id);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error);
    }
  });

  app.post('/admin/targets', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, createTargetBody);
    if (input.verify_on_create === true && input.confirm_model_usage !== true) {
      throw new GatewayError(
        400,
        'model_usage_confirmation_required',
        'model usage confirmation required',
      );
    }
    try {
      const created = deps.targets.create(asTargetInput(input));
      if (input.verify_on_create !== true) return reply.code(201).send(created);

      try {
        const capabilities = await capabilityService().verifyTarget(created.id, true);
        return reply.headers(noStore).code(201).send({
          target: deps.targets.get(created.id),
          capabilities,
          model_usage_consumed: true,
        });
      } catch (error) {
        deps.targets.delete(created.id);
        throw error;
      }
    } catch (error) {
      return knownError(error);
    }
  });

  app.get('/admin/targets', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    return reply.send({ targets: deps.targets.list() });
  });

  app.patch('/admin/targets/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, updateTargetBody);
    try {
      if (input.enabled === true) {
        const target = deps.targets.get(id);
        const current = target === null ? undefined : capabilityService().listAvailability()
          .find((entry) => entry.cli === target.cli);
        if (current && target?.capabilityVersion !== null && (!current.capabilities.available
          || current.capabilities.version !== target?.capabilityVersion)) {
          throw new Error('capability_mismatch');
        }
      }
      return reply.send(deps.targets.update(id, asTargetPatch(input)));
    } catch (error) {
      return knownError(error);
    }
  });

  app.delete('/admin/targets/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    try {
      deps.targets.delete(id);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error);
    }
  });

  const availabilityResponse = () => ({
    cli_availability: capabilityService().listAvailability().map((entry) => ({
      ...entry,
      verificationCount: deps.targets.list().filter((target) =>
        target.cli === entry.cli && target.capabilityVerifiedAt !== null).length,
    })),
  });

  app.get('/admin/cli-availability', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    return reply.headers(noStore).send(availabilityResponse());
  });

  app.post('/admin/cli-availability/refresh', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    body(request, emptyBody);
    await capabilityService().scanInstalled();
    return reply.headers(noStore).send(availabilityResponse());
  });

  app.get('/admin/extensions', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const records = new Map(deps.extensions.list().map((record) => [record.id, record]));
    const health = deps.extensionHealth ? await deps.extensionHealth() : {};
    const manifests = deps.extensionManifests ?? deps.extensions.list().map((record) => ({
      id: record.id,
      version: record.version,
      requiredGatewayVersion: 'unknown',
      endpoint: '-',
    }));
    return reply.headers(noStore).send({
      extensions: manifests.map((manifest) => ({
        ...manifest,
        enabled: records.get(manifest.id)?.enabled ?? false,
        health: health[manifest.id] ?? { ok: false, detail: 'not_started' },
      })),
    });
  });

  app.patch('/admin/extensions/:id', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, extensionToggleBody);
    const manifest = deps.extensionManifests?.find((item) => item.id === id);
    if (!manifest) throw new GatewayError(404, 'extension_not_found', 'control-plane resource not found');
    const existing = deps.extensions.list().find((record) => record.id === id);
    if (existing) deps.extensions.setEnabled(id, input.enabled);
    else deps.extensions.upsert(id, manifest.version, input.enabled);
    return reply.send({ enabled: input.enabled });
  });

  app.post('/admin/targets/:id/verify', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    const input = body(request, verifyTargetBody);
    const capabilities = await capabilityService().verifyTarget(id, input.confirm_model_usage);
    return reply.headers(noStore).send({
      capabilities,
      model_usage_consumed: true,
    });
  });

  app.post('/admin/grants', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, createGrantBody);
    try {
      deps.grants.grant(input.client_id, input.extension_id, input.target_id);
      return reply.code(201).send({
        clientId: input.client_id,
        extensionId: input.extension_id,
        targetId: input.target_id,
      });
    } catch (error) {
      return knownError(error);
    }
  });

  app.delete('/admin/grants', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const input = body(request, createGrantBody);
    try {
      deps.grants.revoke(input.client_id, input.extension_id, input.target_id);
      return reply.code(204).send();
    } catch (error) {
      return knownError(error);
    }
  });

  app.get('/admin/runs', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const filters = query(request, runsQuery);
    const runs = deps.runs.list()
      .filter((run) => filters.status === undefined || run.status === filters.status)
      .filter((run) => filters.target_id === undefined || run.targetId === filters.target_id)
      .filter((run) => filters.client_id === undefined || run.clientId === filters.client_id)
      .slice(0, filters.limit);
    const verifiedTargetCount = deps.targets.list()
      .filter((target) => target.capabilityVerifiedAt !== null).length;
    return reply.send({ runs, verifiedTargetCount });
  });

  app.get('/admin/runs/overview', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const allRuns = deps.runs.list();
    const pressure = new Map<string, { targetId: string; queued: number; running: number }>();
    for (const run of allRuns) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      const target = pressure.get(run.targetId) ?? { targetId: run.targetId, queued: 0, running: 0 };
      target[run.status] += 1;
      pressure.set(run.targetId, target);
    }
    const queuePressure = [...pressure.values()]
      .sort((left, right) => right.queued - left.queued || left.targetId.localeCompare(right.targetId));
    const verifiedTargetCount = deps.targets.list()
      .filter((target) => target.capabilityVerifiedAt !== null).length;
    return reply.send({
      runs: allRuns.slice(0, 20),
      verifiedTargetCount,
      activeRunCount: queuePressure.reduce((total, target) => total + target.queued + target.running, 0),
      queuePressure,
    });
  });

  app.post('/admin/runs/:id/cancel', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    const { id } = params(request);
    body(request, emptyBody);
    const run = deps.runs.get(id);
    if (!run) throw new GatewayError(404, 'run_not_found', 'Gateway run not found');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new GatewayError(409, 'run_not_cancellable', 'Gateway run is no longer cancellable');
    }
    if (!deps.runCanceller) {
      throw new GatewayError(503, 'run_cancellation_unavailable', 'run cancellation unavailable');
    }

    const cancelled = await deps.runCanceller.cancel(id);
    if (!cancelled) {
      throw new GatewayError(409, 'run_not_cancellable', 'Gateway run is no longer cancellable');
    }
    return reply.send({ cancelled: true, id });
  });
}
