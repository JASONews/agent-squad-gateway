import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { ExtensionContext, GatewayExtension } from '../contract.js';
import { requireOpenAIClient } from './auth.js';
import { handleChatCompletion, handleChatCompletionStream } from './chat.js';
import { OpenAIError, sendOpenAIError } from './errors.js';
import { listOpenAIModels, OPENAI_EXTENSION_ID } from './models.js';
import { handleResponse, handleResponseStream } from './responses.js';
import { OpenAIRunAttempt } from './run-attempt.js';

function requestsStream(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'stream' in body && body.stream === true;
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAIError(400, 'Invalid Idempotency-Key header', 'invalid_request_error', null, 'invalid_idempotency_key');
  }
  return value;
}

async function withRunAttempt<T>(
  context: ExtensionContext,
  clientId: string,
  endpoint: 'chat.completions' | 'responses',
  body: unknown,
  execute: (attempt: OpenAIRunAttempt) => Promise<T>,
): Promise<T> {
  const attempt = new OpenAIRunAttempt(context.runs, clientId, endpoint, body);
  try {
    const result = await execute(attempt);
    attempt.complete();
    return result;
  } catch (error) {
    attempt.fail(error);
    throw error;
  }
}

function registerRoutes(app: FastifyInstance, context: ExtensionContext): void {
  app.decorateRequest('openAIClient', null);
  app.setErrorHandler((error, _request, reply) => sendOpenAIError(reply, error));
  app.setNotFoundHandler((_request, reply) => sendOpenAIError(
    reply,
    new OpenAIError(404, 'Not found', 'invalid_request_error', null, 'not_found'),
  ));
  app.addHook('preHandler', requireOpenAIClient(context.credentials));

  app.get('/models', async (request, reply) => {
    if (!request.openAIClient) {
      throw new OpenAIError(401, 'Invalid authentication credentials', 'invalid_request_error', null, 'invalid_api_key');
    }
    return reply.send(listOpenAIModels(request.openAIClient.clientId, context));
  });

  app.post('/chat/completions', async (request, reply) => {
    if (!request.openAIClient) {
      throw new OpenAIError(401, 'Invalid authentication credentials', 'invalid_request_error', null, 'invalid_api_key');
    }
    const clientId = request.openAIClient.clientId;
    if (requestsStream(request.body)) {
      await withRunAttempt(context, clientId, 'chat.completions', request.body, (attempt) => (
        handleChatCompletionStream(
          reply,
          clientId,
          request.body,
          context,
          attempt,
          idempotencyKey(request),
        )
      ));
      return reply;
    }
    const completion = await withRunAttempt(context, clientId, 'chat.completions', request.body, (attempt) => (
      handleChatCompletion(clientId, request.body, context, attempt, idempotencyKey(request))
    ));
    return reply.send(completion);
  });

  app.post('/responses', async (request, reply) => {
    if (!request.openAIClient) {
      throw new OpenAIError(401, 'Invalid authentication credentials', 'invalid_request_error', null, 'invalid_api_key');
    }
    const clientId = request.openAIClient.clientId;
    if (requestsStream(request.body)) {
      await withRunAttempt(context, clientId, 'responses', request.body, (attempt) => (
        handleResponseStream(
          reply,
          clientId,
          request.body,
          context,
          attempt,
          idempotencyKey(request),
        )
      ));
      return reply;
    }
    const response = await withRunAttempt(context, clientId, 'responses', request.body, (attempt) => (
      handleResponse(clientId, request.body, context, attempt, idempotencyKey(request))
    ));
    return reply.send(response);
  });
}

export const openAIExtension: GatewayExtension = {
  manifest: {
    id: OPENAI_EXTENSION_ID,
    version: '1.0.0',
    requiredGatewayVersion: '0.1.0',
  },
  register(context) {
    context.app.register(async (app) => registerRoutes(app, context), { prefix: '/v1' });
  },
  async start() {},
  async stop() {},
  async health() { return { ok: true }; },
};
