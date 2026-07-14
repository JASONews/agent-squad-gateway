import type { FastifyInstance } from 'fastify';
import type { CredentialService } from '../control-plane/credentials.js';
import type { ExtensionRepository } from '../control-plane/extensions.js';
import type { GrantRepository } from '../control-plane/grants.js';
import type { IdempotencyService } from '../control-plane/idempotency.js';
import type { ResponseSessionRepository } from '../control-plane/response-sessions.js';
import type { RunRepository } from '../control-plane/runs.js';
import type { TargetRepository } from '../control-plane/targets.js';
import type { InvocationTarget } from '../control-plane/types.js';
import type { InvocationRequest } from '../provider-runtime/invocation-service.js';
import type { ProviderEvent } from '../provider-runtime/types.js';
import type { RetentionWorkspaceOutcome, WorkspaceLease } from '../provider-runtime/workspaces.js';

export interface InvocationServiceLike {
  invoke(request: InvocationRequest): AsyncIterable<ProviderEvent>;
}

export interface ResponseWorkspaceLike {
  createResponse(target: InvocationTarget, responseId: string): Promise<WorkspaceLease>;
  cleanupExpired(paths: string[]): Promise<void>;
  cleanupForRetention?(paths: string[]): Promise<RetentionWorkspaceOutcome[]>;
}

export interface ExtensionContext {
  app: FastifyInstance;
  credentials: CredentialService;
  extensions: ExtensionRepository;
  grants: GrantRepository;
  targets: TargetRepository;
  idempotency: IdempotencyService;
  invocationService: InvocationServiceLike;
  runs: RunRepository;
  responseSessions: ResponseSessionRepository;
  responseWorkspaces: ResponseWorkspaceLike;
}

export interface GatewayExtension {
  manifest: {
    id: string;
    version: string;
    requiredGatewayVersion: string;
  };
  register(context: ExtensionContext): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
