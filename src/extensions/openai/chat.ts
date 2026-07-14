import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { GrantRepository } from '../../control-plane/grants.js';
import {
  IdempotencyConflictError,
  type IdempotencyDecision,
  type IdempotencyService,
} from '../../control-plane/idempotency.js';
import { reserveRunId } from '../../control-plane/runs.js';
import type { TargetRepository } from '../../control-plane/targets.js';
import type { InvocationServiceLike } from '../contract.js';
import {
  deserializeOpenAIReplay,
  OpenAIError,
  serializeOpenAIFailure,
  serializeOpenAISuccess,
} from './errors.js';
import { OPENAI_EXTENSION_ID } from './models.js';
import type { OpenAIRunAttempt } from './run-attempt.js';
import { ChatRequestSchema, type ChatRequest } from './schemas.js';
import { writeChatStream } from './sse.js';
import {
  AdapterProtocolError,
  assignGatewayCallIds,
  buildToolOutputSchema,
  normalizeChatToolRoundTrip,
  StructuredEnvelopeDecoder,
  ToolInputError,
  type ToolOutputSchema,
} from './tools.js';

export interface ChatDependencies {
  grants: GrantRepository;
  targets: TargetRepository;
  invocationService: InvocationServiceLike;
  idempotency?: IdempotencyService;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: 0;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls';
  }>;
}

function invalidRequest(): OpenAIError {
  return new OpenAIError(400, 'Invalid request', 'invalid_request_error', null, 'invalid_request');
}

function toolsNotSupported(): OpenAIError {
  return new OpenAIError(
    400,
    'The selected model does not support function tools',
    'invalid_request_error',
    'tools',
    'tools_not_supported',
  );
}

function protocolError(): OpenAIError {
  return new OpenAIError(
    502,
    'The provider returned an invalid response',
    'server_error',
    null,
    'adapter_protocol_error',
  );
}

function providerError(): OpenAIError {
  return new OpenAIError(
    502,
    'The provider could not complete the request',
    'server_error',
    null,
    'provider_error',
  );
}

function toolBridge(request: ChatRequest, targetToolBridge: 'structured_output' | 'none'): ToolOutputSchema | null {
  try {
    const schema = buildToolOutputSchema(request.tools ?? [], request.tool_choice);
    if (schema !== null && targetToolBridge !== 'structured_output') throw toolsNotSupported();
    return schema;
  } catch (error) {
    if (error instanceof OpenAIError) throw error;
    if (error instanceof ToolInputError) throw invalidRequest();
    throw invalidRequest();
  }
}

function chatInput(request: ChatRequest) {
  try {
    return normalizeChatToolRoundTrip(request.messages);
  } catch (error) {
    if (error instanceof ToolInputError) throw invalidRequest();
    throw error;
  }
}

function parseRequest(body: unknown): ChatRequest {
  const result = ChatRequestSchema.safeParse(body);
  if (!result.success) throw invalidRequest();
  return result.data;
}

async function collectCompletion(
  outputSchema: ToolOutputSchema | null,
  invocation: ReturnType<InvocationServiceLike['invoke']>,
): Promise<ReturnType<StructuredEnvelopeDecoder['finish']>> {
  let text = '';
  let completed = 0;
  let terminalSeen = false;
  const decoder = outputSchema === null ? undefined : new StructuredEnvelopeDecoder(outputSchema);

  try {
    for await (const event of invocation) {
      if (terminalSeen) throw protocolError();
      switch (event.type) {
        case 'session_started':
          break;
        case 'text_delta':
          if (decoder) throw protocolError();
          text += event.delta;
          break;
        case 'structured_delta':
          if (!decoder) throw protocolError();
          decoder.push(event.delta);
          break;
        case 'completed':
          completed += 1;
          terminalSeen = true;
          break;
        case 'failed':
          if (event.code === 'adapter_protocol_error') throw protocolError();
          throw providerError();
        case 'cancelled':
          throw new OpenAIError(
            500,
            'The request was cancelled',
            'server_error',
            null,
            'request_cancelled',
          );
        default:
          throw protocolError();
      }
    }
  } catch (error) {
    if (error instanceof OpenAIError) throw error;
    if (error instanceof AdapterProtocolError) throw protocolError();
    throw providerError();
  }

  if (completed !== 1) throw protocolError();
  if (!decoder) return { type: 'assistant_text', content: text };
  try {
    return decoder.finish();
  } catch (error) {
    if (error instanceof AdapterProtocolError) throw protocolError();
    throw error;
  }
}

function completionChoice(result: Awaited<ReturnType<typeof collectCompletion>>) {
  if (result.type === 'assistant_text') {
    return { index: 0 as const, message: { role: 'assistant' as const, content: result.content }, finish_reason: 'stop' as const };
  }
  const calls = assignGatewayCallIds(result.toolCalls);
  return {
    index: 0 as const,
    message: {
      role: 'assistant' as const,
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    },
    finish_reason: 'tool_calls' as const,
  };
}

export async function handleChatCompletion(
  clientId: string,
  body: unknown,
  deps: ChatDependencies,
  attempt: OpenAIRunAttempt,
  idempotencyKey?: string,
): Promise<ChatCompletion> {
  const request = parseRequest(body);
  const configuredTarget = deps.targets.get(request.model);
  if (!configuredTarget) {
    throw new OpenAIError(404, 'Model not found', 'invalid_request_error', null, 'model_not_found');
  }
  attempt.setTarget(configuredTarget.id);

  let target;
  try {
    target = deps.grants.authorize(clientId, OPENAI_EXTENSION_ID, request.model);
  } catch (error) {
    if (error instanceof Error && error.message === 'authorization_denied') {
      throw new OpenAIError(
        403,
        'The model is not available to this client',
        'permission_error',
        null,
        'model_not_allowed',
      );
    }
    throw error;
  }
  const outputSchema = toolBridge(request, target.toolBridge);
  const input = chatInput(request);

  const execute = async (runId?: string): Promise<ChatCompletion> => {
    let invocation;
    try {
      invocation = deps.invocationService.invoke({
        ...(runId === undefined ? {} : { runId }),
        clientId,
        extensionId: OPENAI_EXTENSION_ID,
        targetId: target.id,
        endpoint: 'chat.completions',
        input,
        sessionMode: 'ephemeral',
        ...(outputSchema === null ? {} : { outputSchema }),
      });
    } catch {
      throw providerError();
    }
    const result = await collectCompletion(outputSchema, invocation);

    return {
      id: `chatcmpl_${randomUUID().replaceAll('-', '')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [completionChoice(result)],
    };
  };

  if (idempotencyKey === undefined) return execute(attempt.reserve());
  if (!deps.idempotency) throw new Error('idempotency_service_unavailable');
  let decision: IdempotencyDecision;
  try {
    const runId = reserveRunId();
    decision = deps.idempotency.begin({
      clientId,
      key: idempotencyKey,
      endpoint: 'chat.completions',
      request: body,
      runId,
      run: {
        clientId,
        extensionId: OPENAI_EXTENSION_ID,
        targetId: target.id,
        endpoint: 'chat.completions',
      },
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new OpenAIError(409, 'Idempotency key was reused with a different request', 'invalid_request_error', null, 'idempotency_conflict');
    }
    throw error;
  }
  if (decision.type === 'owner') attempt.claim(decision.runId);
  else attempt.ignore();
  if (decision.type === 'unavailable') {
    throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
  }
  if (decision.type !== 'owner') {
    try {
      return deserializeOpenAIReplay<ChatCompletion>(await deps.idempotency.attach(decision));
    } catch (error) {
      if (error instanceof OpenAIError) throw error;
      throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
    }
  }
  try {
    const completion = await execute(decision.runId);
    deps.idempotency.complete(decision, serializeOpenAISuccess(completion));
    return completion;
  } catch (error) {
    attempt.fail(error);
    deps.idempotency.fail(decision, serializeOpenAIFailure(error));
    throw error;
  }
}

function replayChatEvents(
  completion: ChatCompletion,
  structured: boolean,
): AsyncIterable<import('../../provider-runtime/types.js').ProviderEvent> {
  return (async function* () {
    const message = completion.choices[0]!.message;
    if (structured) {
      const envelope = message.tool_calls
        ? {
            type: 'tool_calls',
            tool_calls: message.tool_calls.map((call) => ({
              name: call.function.name,
              arguments: JSON.parse(call.function.arguments) as Record<string, unknown>,
            })),
          }
        : { type: 'assistant_text', content: message.content ?? '' };
      yield { type: 'structured_delta', delta: JSON.stringify(envelope) } as const;
    } else {
      yield { type: 'text_delta', delta: message.content ?? '' } as const;
    }
    yield { type: 'completed' } as const;
  })();
}

function failChatOwner(
  deps: ChatDependencies,
  decision: IdempotencyDecision | undefined,
  attempt: OpenAIRunAttempt,
  error: unknown,
): void {
  attempt.fail(error);
  if (decision?.type !== 'owner') return;
  try {
    deps.idempotency!.fail(decision, serializeOpenAIFailure(error));
  } catch {
    // A finalization callback may have settled before surfacing its failure.
  }
}

export async function handleChatCompletionStream(
  reply: FastifyReply,
  clientId: string,
  body: unknown,
  deps: ChatDependencies,
  attempt: OpenAIRunAttempt,
  idempotencyKey?: string,
): Promise<void> {
  const request = parseRequest(body);
  const configuredTarget = deps.targets.get(request.model);
  if (!configuredTarget) {
    throw new OpenAIError(404, 'Model not found', 'invalid_request_error', null, 'model_not_found');
  }
  attempt.setTarget(configuredTarget.id);

  let target;
  try {
    target = deps.grants.authorize(clientId, OPENAI_EXTENSION_ID, request.model);
  } catch (error) {
    if (error instanceof Error && error.message === 'authorization_denied') {
      throw new OpenAIError(403, 'The model is not available to this client', 'permission_error', null, 'model_not_allowed');
    }
    throw error;
  }
  const outputSchema = toolBridge(request, target.toolBridge);
  const input = chatInput(request);

  let decision: IdempotencyDecision | undefined;
  if (idempotencyKey !== undefined) {
    if (!deps.idempotency) throw new Error('idempotency_service_unavailable');
    try {
      const runId = reserveRunId();
      decision = deps.idempotency.begin({
        clientId,
        key: idempotencyKey,
        endpoint: 'chat.completions',
        request: body,
        runId,
        run: {
          clientId,
          extensionId: OPENAI_EXTENSION_ID,
          targetId: target.id,
          endpoint: 'chat.completions',
        },
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new OpenAIError(409, 'Idempotency key was reused with a different request', 'invalid_request_error', null, 'idempotency_conflict');
      }
      throw error;
    }
    if (decision.type === 'owner') attempt.claim(decision.runId);
    else attempt.ignore();
    if (decision.type === 'unavailable') {
      throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
    }
    if (decision.type !== 'owner') {
      let completion: ChatCompletion;
      try {
        completion = deserializeOpenAIReplay<ChatCompletion>(await deps.idempotency.attach(decision));
      } catch (error) {
        if (error instanceof OpenAIError) throw error;
        throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
      }
      try {
        await writeChatStream(reply, replayChatEvents(completion, outputSchema !== null), {
          id: completion.id,
          created: completion.created,
          model: completion.model,
          outputSchema,
          ...(completion.choices[0]!.message.tool_calls
            ? { replayCallIds: completion.choices[0]!.message.tool_calls.map((call) => call.id) }
            : {}),
        });
      } catch (error) {
        if (!reply.raw.headersSent) throw error;
      }
      return;
    }
  }

  const id = `chatcmpl_${randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  let ownerSettled = false;
  const runId = decision?.type === 'owner' ? decision.runId : attempt.reserve();
  let invocation;
  try {
    invocation = deps.invocationService.invoke({
      runId,
      clientId,
      extensionId: OPENAI_EXTENSION_ID,
      targetId: target.id,
      endpoint: 'chat.completions',
      input,
      sessionMode: 'ephemeral',
      ...(outputSchema === null ? {} : { outputSchema }),
    });
  } catch {
    const error = providerError();
    failChatOwner(deps, decision, attempt, error);
    throw error;
  }

  try {
    await writeChatStream(reply, invocation, {
      id,
      created,
      model: request.model,
      outputSchema,
      beforeTerminal: decision?.type === 'owner'
        ? (result) => {
            const completion: ChatCompletion = {
              id,
              object: 'chat.completion',
              created,
              model: request.model,
              choices: [result.toolCalls
                ? {
                    index: 0,
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: result.toolCalls.map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                      })),
                    },
                    finish_reason: 'tool_calls',
                  }
                : {
                    index: 0,
                    message: { role: 'assistant', content: result.text },
                    finish_reason: 'stop',
                  }],
            };
            deps.idempotency!.complete(decision, serializeOpenAISuccess(completion));
            ownerSettled = true;
          }
        : undefined,
    });
  } catch (error) {
    if (!ownerSettled) failChatOwner(deps, decision, attempt, error);
    if (!reply.raw.headersSent) throw error;
  }
}
