import type { FastifyInstance } from 'fastify';
import { z, ZodError, type ZodType } from 'zod';
import type { GatewayWebUiAuthMode } from '../config/config.js';
import { CoreClientError, type CoreClient } from '../core-client/client.js';
import { proxyCoreEvents, type CoreEventProxyOptions } from '../core-client/event-proxy.js';
import type { CoreChoice } from '../core-client/types.js';
import type { CoreConnectionRepository } from '../control-plane/core-connection.js';
import type { AdminAuthService } from '../security/admin-auth.js';
import { requireAdmin } from './auth-hooks.js';
import { GatewayError } from './errors.js';

const noStore = { 'cache-control': 'no-store' };
const idParams = z.object({ id: z.string().min(1) }).strict();
const choiceParams = z.object({ id: z.string().min(1), choiceId: z.string().min(1) }).strict();
const pendingQuery = z.object({ status: z.literal('pending') }).strict();
const resolveBody = z.object({ selected: z.string().min(1), rationale: z.string().optional() }).strict();

export interface CoreRouteDependencies {
  client: CoreClient;
  connection: CoreConnectionRepository;
  adminAuth: AdminAuthService;
  webUiAuth: GatewayWebUiAuthMode;
  gatewayOrigin: string;
  eventProxyOptions?: CoreEventProxyOptions;
}

export function registerCoreRoutes(app: FastifyInstance, deps: CoreRouteDependencies): void {
  const requireAuthenticatedAdmin = requireAdmin(
    deps.adminAuth,
    deps.gatewayOrigin,
    deps.webUiAuth === 'token',
  );
  const connection = () => {
    deps.connection.update(deps.client.baseUrl);
    return deps.connection;
  };

  app.get('/admin/core/health', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    const repository = connection();
    try {
      const health = await deps.client.health();
      return reply.headers(noStore).send({ ...health, connection: repository.markHealth(health) });
    } catch (error) {
      repository.markHealth(undefined);
      throw asGatewayError(error);
    }
  });

  app.get('/admin/core/sessions', { preHandler: requireAuthenticatedAdmin }, async (_request, reply) => {
    connection();
    try {
      return reply.headers(noStore).send({ sessions: await deps.client.listSessions() });
    } catch (error) {
      throw asGatewayError(error);
    }
  });

  app.get('/admin/core/sessions/:id/debug', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    connection();
    const { id } = parse(idParams, request.params, 'request path');
    try {
      return reply.headers(noStore).send(await deps.client.getSessionDebug(id));
    } catch (error) {
      throw asGatewayError(error);
    }
  });

  app.get('/admin/core/choices', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    connection();
    parse(pendingQuery, request.query, 'request query');
    try {
      const sessions = await deps.client.listSessions();
      const perSession = await mapConcurrent(sessions, 4, (session) => deps.client.listChoices(session.id));
      const choices = perSession.flat().filter((choice) => choice.status === 'pending_main_agent');
      return reply.headers(noStore).send({ choices });
    } catch (error) {
      throw asGatewayError(error);
    }
  });

  app.get('/admin/core/events', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    await proxyCoreEvents(request, reply, deps.client, connection(), deps.eventProxyOptions);
  });

  app.post('/admin/core/sessions/:id/choices/:choiceId/resolve', { preHandler: requireAuthenticatedAdmin }, async (request, reply) => {
    connection();
    const { id, choiceId } = parse(choiceParams, request.params, 'request path');
    const input = parse(resolveBody, request.body ?? {}, 'request body');
    try {
      const choices = await deps.client.listChoices(id);
      const choice = choices.find((candidate) => candidate.id === choiceId);
      assertPending(choice);
      if (!choice.options.some((option) => option.id === input.selected)) {
        throw new GatewayError(400, 'core_choice_option_invalid', 'selected option is invalid');
      }
      await deps.client.resolveChoice(id, choiceId, input.selected, input.rationale);
      const liveChoices = await deps.client.listChoices(id);
      const resolvedChoice = liveChoices.find((candidate) => candidate.id === choiceId);
      assertApplied(resolvedChoice, input.selected, input.rationale);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw asGatewayError(error);
    }
  });
}

function assertPending(choice: CoreChoice | undefined): asserts choice is CoreChoice {
  if (!choice || choice.status !== 'pending_main_agent') {
    throw new GatewayError(409, 'core_choice_not_pending', 'Core choice is not pending');
  }
}

function assertApplied(choice: CoreChoice | undefined, selected: string, rationale?: string): asserts choice is CoreChoice {
  if (!choice
    || choice.status !== 'resolved'
    || choice.selected !== selected
    || (rationale !== undefined && choice.rationale !== rationale)) {
    throw new GatewayError(409, 'core_choice_not_pending', 'Core choice is not pending');
  }
}

function parse<S extends ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) throw new GatewayError(400, 'validation_error', `invalid ${label}`);
    throw error;
  }
}

function asGatewayError(error: unknown): GatewayError {
  if (error instanceof CoreClientError) return new GatewayError(error.status, error.code, error.message);
  return new GatewayError(500, 'internal_error', 'internal gateway error');
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]!);
    }
  }));
  return results;
}
