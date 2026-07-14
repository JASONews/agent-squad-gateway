import Fastify, { type FastifyInstance } from 'fastify';
import { formatGatewayAddress, gatewayLoopbackOrigin, type GatewayConfig } from '../config/config.js';
import { CoreClient } from '../core-client/client.js';
import type { CoreEventProxyOptions } from '../core-client/event-proxy.js';
import type { ClientRepository } from '../control-plane/clients.js';
import { CoreConnectionRepository } from '../control-plane/core-connection.js';
import type { CredentialService } from '../control-plane/credentials.js';
import type { GatewayDb } from '../control-plane/db.js';
import type { ExtensionRepository } from '../control-plane/extensions.js';
import type { GrantRepository } from '../control-plane/grants.js';
import { IdempotencyService } from '../control-plane/idempotency.js';
import { RetentionService, type RetentionLifecycle } from '../control-plane/retention.js';
import { ResponseSessionRepository } from '../control-plane/response-sessions.js';
import type { RunRepository } from '../control-plane/runs.js';
import type { TargetRepository } from '../control-plane/targets.js';
import { openAIExtension } from '../extensions/openai/routes.js';
import type { InvocationServiceLike, ResponseWorkspaceLike } from '../extensions/contract.js';
import { GatewayExtensionRegistry } from '../extensions/registry.js';
import { CapabilityService } from '../provider-runtime/capability-service.js';
import { InvocationService } from '../provider-runtime/invocation-service.js';
import {
  registerBuiltInProviders,
  type BuiltInProviderOptions,
} from '../provider-runtime/register-providers.js';
import { ProviderRegistry } from '../provider-runtime/registry.js';
import { TargetScheduler } from '../provider-runtime/scheduler.js';
import { WorkspaceManager } from '../provider-runtime/workspaces.js';
import { ReplayBuffer } from '../provider-runtime/replay-buffer.js';
import type { AdminAuthService } from '../security/admin-auth.js';
import { registerAdminRoutes } from './admin-routes.js';
import { VITE_DEV_ORIGIN } from './auth-hooks.js';
import { registerCoreRoutes } from './core-routes.js';
import { sendGatewayError } from './errors.js';
import { registerUiRoutes } from './ui-routes.js';

export interface GatewayAppDependencies {
  config: GatewayConfig;
  db: GatewayDb;
  clients: ClientRepository;
  credentials: CredentialService;
  targets: TargetRepository;
  grants: GrantRepository;
  extensions: ExtensionRepository;
  runs: RunRepository;
  adminAuth: AdminAuthService;
  invocationService?: InvocationServiceLike & {
    abortActive?(): Promise<void>;
    cancel?(runId: string): Promise<boolean>;
  };
  responseSessions?: ResponseSessionRepository;
  responseWorkspaces?: ResponseWorkspaceLike;
  replayBuffer?: ReplayBuffer;
  idempotency?: IdempotencyService;
  retention?: RetentionLifecycle;
  capabilityService?: CapabilityService;
  providers?: ProviderRegistry;
  providerOptions?: BuiltInProviderOptions;
  scanCapabilitiesOnReady?: boolean;
  coreClient?: CoreClient;
  coreConnection?: CoreConnectionRepository;
  coreEventProxyOptions?: CoreEventProxyOptions;
}

export function buildGatewayApp(deps: GatewayAppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const gatewayOrigin = gatewayLoopbackOrigin(deps.config);
  const bindOrigin = `http://${formatGatewayAddress(deps.config.host, deps.config.port)}`;
  const trustedAdminOrigins = new Set([gatewayOrigin, bindOrigin, VITE_DEV_ORIGIN]);
  app.setErrorHandler((error, _request, reply) => sendGatewayError(reply, error));
  const providers = deps.providers ?? new ProviderRegistry();
  const coreConnection = deps.coreConnection ?? new CoreConnectionRepository(deps.db);
  let persistedCoreUrl = deps.config.coreUrl;
  try {
    persistedCoreUrl = coreConnection.get().baseUrl;
  } catch (error) {
    let databaseAvailable = true;
    try {
      deps.db.prepare<[], { probe: number }>('SELECT 1 AS probe').get();
    } catch {
      databaseAvailable = false;
    }
    if (databaseAvailable) throw error;
    // Keep the health endpoint constructible when the database itself is unavailable.
    persistedCoreUrl = deps.config.coreUrl;
  }
  deps.config.coreUrl = persistedCoreUrl;
  const coreClient = deps.coreClient ?? new CoreClient(persistedCoreUrl);
  coreClient.setBaseUrl(persistedCoreUrl);
  if (!deps.providers) registerBuiltInProviders(providers, deps.providerOptions);
  const responseSessions = deps.responseSessions ?? new ResponseSessionRepository(deps.db);
  const replayBuffer = deps.replayBuffer ?? new ReplayBuffer();
  const idempotency = deps.idempotency ?? new IdempotencyService(deps.db, deps.runs, replayBuffer);
  const responseWorkspaces = deps.responseWorkspaces ?? new WorkspaceManager(
    deps.config.paths.workspacesDir,
    {
      getFixedWorkspaces: () => deps.targets.list()
        .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
    },
  );
  const providerWorkspaces = responseWorkspaces instanceof WorkspaceManager
    ? responseWorkspaces
    : new WorkspaceManager(deps.config.paths.workspacesDir, {
      getFixedWorkspaces: () => deps.targets.list()
        .flatMap((target) => target.fixedWorkspace === null ? [] : [target.fixedWorkspace]),
    });
  const capabilityService = deps.capabilityService
    ?? new CapabilityService(providers, deps.targets, providerWorkspaces);
  const invocationService = deps.invocationService ?? new InvocationService(
    providers,
    new TargetScheduler(),
    providerWorkspaces,
    deps.targets,
    deps.runs,
  );
  const retention = deps.retention ?? (deps.db.raw
    ? new RetentionService(deps.db, responseSessions, {
      cleanupForRetention(paths) {
        if (!responseWorkspaces.cleanupForRetention) {
          throw new Error('retention_workspace_cleanup_unsupported');
        }
        return responseWorkspaces.cleanupForRetention(paths);
      },
    })
    : undefined);

  const extensionRegistry = new GatewayExtensionRegistry({
    app,
    credentials: deps.credentials,
    extensions: deps.extensions,
    grants: deps.grants,
    targets: deps.targets,
    idempotency,
    invocationService,
    runs: deps.runs,
    responseSessions,
    responseWorkspaces,
  });
  let serviceShutdownFailure: { error: unknown } | undefined;
  app.addHook('preClose', async () => {
    try {
      await closeServicesInOrder([
        () => invocationService.abortActive?.(),
        () => providers.dispose(),
        () => retention?.stop(),
        () => extensionRegistry.stop(),
      ]);
    } catch (error) {
      serviceShutdownFailure = { error };
    }
  });
  // Fastify does not propagate preClose failures, so relay only the captured error after drain.
  app.addHook('onClose', async () => {
    if (serviceShutdownFailure) throw serviceShutdownFailure.error;
  });
  extensionRegistry.register(openAIExtension);
  if (retention) {
    app.addHook('onReady', async () => {
      await retention.reconcileStartup();
      await retention.sweep();
      retention.start();
    });
  }
  if (deps.scanCapabilitiesOnReady) {
    app.addHook('onReady', async () => {
      await capabilityService.scanInstalled();
    });
  }
  app.addHook('onReady', () => extensionRegistry.start());

  app.get('/health', async (_request, reply) => {
    try {
      deps.db.prepare<[], { probe: number }>('SELECT 1 AS probe').get();
      return reply.send({ ok: true, version: '0.1.0', db_ok: true, core_url: deps.config.coreUrl });
    } catch {
      return reply.code(503).send({ ok: false, version: '0.1.0', db_ok: false, core_url: deps.config.coreUrl });
    }
  });

  registerAdminRoutes(app, {
    config: deps.config,
    db: deps.db,
    clients: deps.clients,
    coreClient,
    coreConnection,
    credentials: deps.credentials,
    targets: deps.targets,
    grants: deps.grants,
    extensions: deps.extensions,
    runs: deps.runs,
    adminAuth: deps.adminAuth,
    trustedOrigins: trustedAdminOrigins,
    capabilityService,
    runCanceller: invocationService.cancel
      ? { cancel: (runId) => invocationService.cancel!(runId) }
      : undefined,
    extensionManifests: [{ ...openAIExtension.manifest, endpoint: '/v1' }],
    extensionHealth: () => extensionRegistry.health(),
  });
  registerCoreRoutes(app, {
    client: coreClient,
    connection: coreConnection,
    adminAuth: deps.adminAuth,
    webUiAuth: deps.config.webUiAuth,
    gatewayOrigin,
    eventProxyOptions: deps.coreEventProxyOptions,
  });
  registerUiRoutes(app);
  return app;
}

async function closeServicesInOrder(
  operations: Array<() => void | Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Gateway service shutdown failed');
}
