import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { GrantRepository } from '../../control-plane/grants.js';
import {
  IdempotencyConflictError,
  type IdempotencyDecision,
  type IdempotencyService,
} from '../../control-plane/idempotency.js';
import { reserveRunId } from '../../control-plane/runs.js';
import type {
  ResponseSessionRecord,
  ResponseSessionRepository,
} from '../../control-plane/response-sessions.js';
import type { TargetRepository } from '../../control-plane/targets.js';
import type { InvocationTarget } from '../../control-plane/types.js';
import type { ProviderInputItem } from '../../provider-runtime/types.js';
import type {
  InvocationServiceLike,
  ResponseWorkspaceLike,
} from '../contract.js';
import {
  deserializeOpenAIReplay,
  OpenAIError,
  serializeOpenAIFailure,
  serializeOpenAISuccess,
} from './errors.js';
import { OPENAI_EXTENSION_ID } from './models.js';
import type { OpenAIRunAttempt } from './run-attempt.js';
import {
  ResponsesRequestSchema,
  type ResponsesRequest,
} from './schemas.js';
import { writeResponsesStream } from './sse.js';
import {
  AdapterProtocolError,
  assignGatewayCallIds,
  buildToolOutputSchema,
  FunctionCallMetadataStore,
  normalizeResponsesToolRoundTrip,
  StructuredEnvelopeDecoder,
  ToolInputError,
  type DecodedEnvelope,
  type DecodedToolCall,
  type ToolOutputSchema,
} from './tools.js';

export interface ResponsesDependencies {
  grants: GrantRepository;
  targets: TargetRepository;
  invocationService: InvocationServiceLike;
  responseSessions: ResponseSessionRepository;
  responseWorkspaces: ResponseWorkspaceLike;
  idempotency?: IdempotencyService;
}

export interface OpenAIResponse {
  id: string;
  object: 'response';
  status: 'completed';
  model: string;
  output: Array<
    | {
        id: string;
        type: 'message';
        role: 'assistant';
        status: 'completed';
        content: Array<{
          type: 'output_text';
          text: string;
          annotations: [];
        }>;
      }
    | {
        id: string;
        type: 'function_call';
        status: 'completed';
        arguments: string;
        call_id: string;
        name: string;
      }
  >;
  output_text: string;
}

interface InvocationResult {
  envelope: DecodedEnvelope;
  nativeSessionId: string;
  nativeStateAdvanced: boolean;
}

const responseCallMetadata = new FunctionCallMetadataStore();

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
  return new OpenAIError(502, 'The provider request failed', 'server_error', null, 'provider_error');
}

function workspaceError(): OpenAIError {
  return new OpenAIError(500, 'The response workspace operation failed', 'server_error', null, 'workspace_error');
}

function repositoryError(error: unknown): OpenAIError {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case 'response_not_found':
      return new OpenAIError(404, 'Previous response not found', 'invalid_request_error', null, code);
    case 'response_target_mismatch':
      return new OpenAIError(400, 'Previous response used a different model', 'invalid_request_error', null, code);
    case 'response_expired':
      return new OpenAIError(404, 'Previous response expired', 'invalid_request_error', null, code);
    case 'response_not_stored':
      return new OpenAIError(400, 'Previous response was not stored', 'invalid_request_error', null, code);
    case 'response_in_progress':
      return new OpenAIError(409, 'Previous response is already continuing', 'invalid_request_error', null, code);
    case 'response_already_continued':
      return new OpenAIError(409, 'Previous response was already continued', 'invalid_request_error', null, code);
    case 'response_terminal_failure':
      return new OpenAIError(409, 'Previous response cannot be continued', 'invalid_request_error', null, code);
    default:
      return new OpenAIError(500, 'The response state operation failed', 'server_error', null, 'response_state_error');
  }
}

function parseRequest(body: unknown): ResponsesRequest {
  const result = ResponsesRequestSchema.safeParse(body);
  if (!result.success) throw invalidRequest();
  if (result.data.previous_response_id !== undefined && result.data.store === false) {
    throw invalidRequest();
  }
  return result.data;
}

function authorizeTarget(
  clientId: string,
  model: string,
  deps: ResponsesDependencies,
  attempt: OpenAIRunAttempt,
): InvocationTarget {
  const configuredTarget = deps.targets.get(model);
  if (!configuredTarget) {
    throw new OpenAIError(404, 'Model not found', 'invalid_request_error', null, 'model_not_found');
  }
  attempt.setTarget(configuredTarget.id);
  try {
    return deps.grants.authorize(clientId, OPENAI_EXTENSION_ID, model);
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
}

function responseToolBridge(
  request: ResponsesRequest,
  targetToolBridge: 'structured_output' | 'none',
): ToolOutputSchema | null {
  const tools = (request.tools ?? []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }));
  const choice = typeof request.tool_choice === 'object'
    ? { type: 'function', function: { name: request.tool_choice.name } }
    : request.tool_choice;
  try {
    const schema = buildToolOutputSchema(tools, choice);
    if (schema !== null && targetToolBridge !== 'structured_output') throw toolsNotSupported();
    return schema;
  } catch (error) {
    if (error instanceof OpenAIError) throw error;
    if (error instanceof ToolInputError) throw invalidRequest();
    throw error;
  }
}

function inputItems(request: ResponsesRequest): ProviderInputItem[] {
  if (typeof request.input === 'string') {
    if (request.previous_response_id !== undefined) {
      const expected = responseCallMetadata.find(request.previous_response_id);
      if (expected && expected.size > 0) throw invalidRequest();
    }
    return [{ role: 'user', content: request.input }];
  }
  try {
    const hasOutputs = request.input.some((item) => 'type' in item && item.type === 'function_call_output');
    const expected = request.previous_response_id === undefined
      ? undefined
      : hasOutputs
        ? responseCallMetadata.expected(request.previous_response_id)
        : responseCallMetadata.find(request.previous_response_id);
    if (!hasOutputs && expected && expected.size > 0) throw invalidRequest();
    return normalizeResponsesToolRoundTrip(request.input, expected && expected.size > 0 ? expected : undefined);
  } catch (error) {
    if (error instanceof ToolInputError) throw invalidRequest();
    throw error;
  }
}

async function collectInvocation(
  invocation: AsyncIterable<import('../../provider-runtime/types.js').ProviderEvent>,
  onSessionStarted: (nativeSessionId: string) => void,
  outputSchema: ToolOutputSchema | null,
): Promise<InvocationResult> {
  let text = '';
  let nativeSessionId: string | undefined;
  let nativeStateAdvanced = false;
  let completed = 0;
  let terminalSeen = false;
  const decoder = outputSchema === null ? undefined : new StructuredEnvelopeDecoder(outputSchema);

  try {
    for await (const event of invocation) {
      if (terminalSeen) throw protocolError();
      switch (event.type) {
        case 'session_started':
          if (nativeSessionId !== undefined) throw protocolError();
          nativeSessionId = event.nativeSessionId;
          nativeStateAdvanced = true;
          onSessionStarted(nativeSessionId);
          break;
        case 'text_delta':
          if (nativeSessionId === undefined) throw protocolError();
          if (decoder) throw protocolError();
          text += event.delta;
          break;
        case 'structured_delta':
          if (nativeSessionId === undefined || !decoder) throw protocolError();
          decoder.push(event.delta);
          break;
        case 'completed':
          if (nativeSessionId === undefined) throw protocolError();
          completed += 1;
          terminalSeen = true;
          break;
        case 'failed':
          nativeStateAdvanced ||= event.nativeStateAdvanced;
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
    if (error instanceof OpenAIError) {
      Object.assign(error, { nativeStateAdvanced });
      throw error;
    }
    if (error instanceof AdapterProtocolError) {
      const safe = protocolError();
      Object.assign(safe, { nativeStateAdvanced });
      throw safe;
    }
    const safe = providerError();
    Object.assign(safe, { nativeStateAdvanced });
    throw safe;
  }

  if (completed !== 1 || nativeSessionId === undefined) {
    const error = protocolError();
    Object.assign(error, { nativeStateAdvanced });
    throw error;
  }
  let envelope: DecodedEnvelope = { type: 'assistant_text', content: text };
  if (decoder) {
    try {
      envelope = decoder.finish();
    } catch (error) {
      const safe = error instanceof AdapterProtocolError ? protocolError() : providerError();
      Object.assign(safe, { nativeStateAdvanced });
      throw safe;
    }
  }
  return { envelope, nativeSessionId, nativeStateAdvanced };
}

function advancedFrom(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'nativeStateAdvanced' in error
    && error.nativeStateAdvanced === true;
}

function acquireParent(
  previousResponseId: string,
  targetId: string,
  sessions: ResponseSessionRepository,
): ResponseSessionRecord {
  try {
    const parent = sessions.acquireContinuation(previousResponseId, targetId);
    if (parent.nativeSessionId === null || parent.workspacePath === null) {
      throw new Error('response_chain_invalid');
    }
    return parent;
  } catch (error) {
    throw repositoryError(error);
  }
}

function settleContinuationFailure(
  parentResponseId: string,
  advanced: boolean,
  sessions: ResponseSessionRepository,
): void {
  try {
    if (advanced) sessions.failTerminal(parentResponseId);
    else sessions.releaseBeforeStart(parentResponseId);
  } catch (error) {
    throw repositoryError(error);
  }
}

function settleNewStoredFailure(
  responseId: string,
  targetId: string,
  sessions: ResponseSessionRepository,
): void {
  try {
    sessions.acquireContinuation(responseId, targetId);
    sessions.failTerminal(responseId);
  } catch (error) {
    throw repositoryError(error);
  }
}

async function executeResponse(
  clientId: string,
  request: ResponsesRequest,
  target: InvocationTarget,
  responseId: string,
  input: ProviderInputItem[],
  outputSchema: ToolOutputSchema | null,
  deps: ResponsesDependencies,
  runId?: string,
): Promise<OpenAIResponse> {
  const previousResponseId = request.previous_response_id;
  const stored = request.store !== false;
  const parent = previousResponseId === undefined
    ? undefined
    : acquireParent(previousResponseId, target.id, deps.responseSessions);

  let workspaceLease: Awaited<ReturnType<ResponseWorkspaceLike['createResponse']>> | undefined;
  let workspacePath: string | undefined;
  let sessionPersisted = false;
  let cleanupAbandoned = false;
  let nativeAdvanced = false;
  let result: InvocationResult;

  try {
    if (stored && parent === undefined) {
      try {
        workspaceLease = await deps.responseWorkspaces.createResponse(target, responseId);
        workspacePath = workspaceLease.path;
      } catch {
        throw workspaceError();
      }
    } else if (parent !== undefined) {
      workspacePath = parent.workspacePath!;
    }

    let invocation;
    try {
      invocation = deps.invocationService.invoke({
        ...(runId === undefined ? {} : { runId }),
        clientId,
        extensionId: OPENAI_EXTENSION_ID,
        targetId: target.id,
        endpoint: 'responses',
        responseId,
        input,
        sessionMode: parent === undefined && !stored ? 'ephemeral' : 'persistent',
        ...(outputSchema === null ? {} : { outputSchema }),
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(parent === undefined ? {} : { nativeSessionId: parent.nativeSessionId! }),
      });
    } catch {
      throw providerError();
    }

    result = await collectInvocation(invocation, (nativeSessionId) => {
      if (parent !== undefined) return;
      try {
        deps.responseSessions.create({
          responseId,
          targetId: target.id,
          nativeSessionId,
          workspacePath,
          store: stored,
        });
        sessionPersisted = true;
      } catch (error) {
        throw repositoryError(error);
      }
    }, outputSchema);
    nativeAdvanced = result.nativeStateAdvanced;

    if (parent !== undefined) {
      try {
        deps.responseSessions.completeContinuation({
          parentResponseId: parent.responseId,
          childResponseId: responseId,
          nativeSessionId: result.nativeSessionId,
          workspacePath: parent.workspacePath,
        });
      } catch (error) {
        throw repositoryError(error);
      }
    } else if (!sessionPersisted) {
      throw protocolError();
    }
  } catch (error) {
    const advanced = nativeAdvanced || advancedFrom(error);
    if (parent !== undefined) {
      settleContinuationFailure(parent.responseId, advanced, deps.responseSessions);
    } else if (stored && sessionPersisted && advanced) {
      settleNewStoredFailure(responseId, target.id, deps.responseSessions);
    } else if (stored && !sessionPersisted && workspacePath !== undefined) {
      cleanupAbandoned = true;
    }
    if (error instanceof OpenAIError) throw error;
    throw providerError();
  } finally {
    if (workspaceLease !== undefined) {
      try {
        await workspaceLease.release();
        if (cleanupAbandoned && workspacePath !== undefined) {
          await deps.responseWorkspaces.cleanupExpired([workspacePath]);
        }
      } catch {
        throw workspaceError();
      }
    }
  }

  const response = responseFromEnvelope(responseId, request.model, result.envelope);
  if (stored) responseCallMetadata.remember(responseId, response.output
    .filter((item) => item.type === 'function_call')
    .map((item) => item.call_id));
  return response;
}

export async function handleResponse(
  clientId: string,
  body: unknown,
  deps: ResponsesDependencies,
  attempt: OpenAIRunAttempt,
  idempotencyKey?: string,
): Promise<OpenAIResponse> {
  const request = parseRequest(body);
  const target = authorizeTarget(clientId, request.model, deps, attempt);
  const outputSchema = responseToolBridge(request, target.toolBridge);
  const input = inputItems(request);
  const responseId = `resp_${randomUUID()}`;
  attempt.setResponseId(responseId);
  if (idempotencyKey === undefined) {
    return executeResponse(
      clientId,
      request,
      target,
      responseId,
      input,
      outputSchema,
      deps,
      attempt.reserve(),
    );
  }
  if (!deps.idempotency) throw new Error('idempotency_service_unavailable');

  let decision: IdempotencyDecision;
  try {
    const runId = reserveRunId();
    decision = deps.idempotency.begin({
      clientId,
      key: idempotencyKey,
      endpoint: 'responses',
      request: body,
      runId,
      responseId,
      run: {
        clientId,
        extensionId: OPENAI_EXTENSION_ID,
        targetId: target.id,
        endpoint: 'responses',
        responseId,
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
      return deserializeOpenAIReplay<OpenAIResponse>(await deps.idempotency.attach(decision));
    } catch (error) {
      if (error instanceof OpenAIError) throw error;
      throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
    }
  }

  try {
    const response = await executeResponse(
      clientId,
      request,
      target,
      responseId,
      input,
      outputSchema,
      deps,
      decision.runId,
    );
    deps.idempotency.complete(decision, serializeOpenAISuccess(response));
    return response;
  } catch (error) {
    attempt.fail(error);
    deps.idempotency.fail(decision, serializeOpenAIFailure(error));
    throw error;
  }
}

function responseFromEnvelope(
  responseId: string,
  model: string,
  envelope: DecodedEnvelope,
  options?: {
    messageId?: string;
    toolCalls?: Array<DecodedToolCall & { id: string; itemId?: string }>;
  },
): OpenAIResponse {
  if (envelope.type === 'tool_calls') {
    const calls = options?.toolCalls ?? assignGatewayCallIds(envelope.toolCalls);
    return {
      id: responseId,
      object: 'response',
      status: 'completed',
      model,
      output: calls.map((call) => {
        const itemId = (call as DecodedToolCall & { id: string; itemId?: string }).itemId;
        return {
          id: itemId ?? `fc_${randomUUID()}`,
          type: 'function_call' as const,
          status: 'completed' as const,
          arguments: JSON.stringify(call.arguments),
          call_id: call.id,
          name: call.name,
        };
      }),
      output_text: '',
    };
  }
  return {
    id: responseId,
    object: 'response',
    status: 'completed',
    model,
    output: [{
      id: options?.messageId ?? `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: envelope.content, annotations: [] }],
    }],
    output_text: envelope.content,
  };
}

function replayResponseEvents(response: OpenAIResponse): AsyncIterable<import('../../provider-runtime/types.js').ProviderEvent> {
  return (async function* () {
    yield { type: 'session_started', nativeSessionId: 'replay' } as const;
    const functionCalls = response.output.filter((item) => item.type === 'function_call');
    if (functionCalls.length > 0) {
      yield {
        type: 'structured_delta',
        delta: JSON.stringify({
          type: 'tool_calls',
          tool_calls: functionCalls.map((item) => ({
            name: item.name,
            arguments: JSON.parse(item.arguments) as Record<string, unknown>,
          })),
        }),
      } as const;
    } else {
      yield { type: 'text_delta', delta: response.output_text } as const;
    }
    yield { type: 'completed' } as const;
  })();
}

async function executeResponseStream(
  reply: FastifyReply,
  clientId: string,
  request: ResponsesRequest,
  target: InvocationTarget,
  responseId: string,
  outputId: string,
  input: ProviderInputItem[],
  outputSchema: ToolOutputSchema | null,
  deps: ResponsesDependencies,
  runId?: string,
  finalizeSuccess?: (response: OpenAIResponse) => void | Promise<void>,
): Promise<OpenAIResponse> {
  const previousResponseId = request.previous_response_id;
  const stored = request.store !== false;
  const parent = previousResponseId === undefined
    ? undefined
    : acquireParent(previousResponseId, target.id, deps.responseSessions);

  let workspaceLease: Awaited<ReturnType<ResponseWorkspaceLike['createResponse']>> | undefined;
  let workspacePath: string | undefined;
  let sessionPersisted = false;
  let cleanupAbandoned = false;
  let nativeAdvanced = false;
  let workspaceReleaseAttempted = false;
  let parentTransitionFinalized = false;
  let successFinalized = false;
  let finalResponse: OpenAIResponse | undefined;

  const releaseWorkspace = async (cleanup: boolean): Promise<void> => {
    if (workspaceLease === undefined || workspaceReleaseAttempted) return;
    workspaceReleaseAttempted = true;
    try {
      await workspaceLease.release();
      if (cleanup && workspacePath !== undefined) {
        await deps.responseWorkspaces.cleanupExpired([workspacePath]);
      }
    } catch {
      throw workspaceError();
    }
  };

  try {
    if (stored && parent === undefined) {
      try {
        workspaceLease = await deps.responseWorkspaces.createResponse(target, responseId);
        workspacePath = workspaceLease.path;
      } catch {
        throw workspaceError();
      }
    } else if (parent !== undefined) {
      workspacePath = parent.workspacePath!;
    }

    let invocation;
    try {
      invocation = deps.invocationService.invoke({
        ...(runId === undefined ? {} : { runId }),
        clientId,
        extensionId: OPENAI_EXTENSION_ID,
        targetId: target.id,
        endpoint: 'responses',
        responseId,
        input,
        sessionMode: parent === undefined && !stored ? 'ephemeral' : 'persistent',
        ...(outputSchema === null ? {} : { outputSchema }),
        ...(workspacePath === undefined ? {} : { workspacePath }),
        ...(parent === undefined ? {} : { nativeSessionId: parent.nativeSessionId! }),
      });
    } catch {
      throw providerError();
    }

    const result = await writeResponsesStream(reply, invocation, {
      responseId,
      outputId,
      model: request.model,
      outputSchema,
      onSessionStarted: (nativeSessionId) => {
        if (parent !== undefined) return;
        try {
          deps.responseSessions.create({
            responseId,
            targetId: target.id,
            nativeSessionId,
            workspacePath,
            store: stored,
          });
          sessionPersisted = true;
        } catch (error) {
          throw repositoryError(error);
        }
      },
      beforeTerminal: async (result) => {
        nativeAdvanced = result.nativeStateAdvanced;
        if (parent !== undefined) {
          try {
            deps.responseSessions.completeContinuation({
              parentResponseId: parent.responseId,
              childResponseId: responseId,
              nativeSessionId: result.nativeSessionId!,
              workspacePath: parent.workspacePath,
            });
            parentTransitionFinalized = true;
          } catch (error) {
            throw repositoryError(error);
          }
        } else if (!sessionPersisted) {
          throw protocolError();
        }

        const envelope: DecodedEnvelope = result.toolCalls
          ? { type: 'tool_calls', toolCalls: result.toolCalls }
          : { type: 'assistant_text', content: result.text };
        const response = responseFromEnvelope(responseId, request.model, envelope, {
          messageId: outputId,
          ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
        });
        if (stored) responseCallMetadata.remember(responseId, response.output
          .filter((item) => item.type === 'function_call')
          .map((item) => item.call_id));
        await releaseWorkspace(false);
        await finalizeSuccess?.(response);
        finalResponse = response;
        successFinalized = true;
      },
    });
    nativeAdvanced = result.nativeStateAdvanced;
    return finalResponse!;
  } catch (error) {
    const advanced = nativeAdvanced || advancedFrom(error);
    if (!successFinalized) {
      if (parent !== undefined && !parentTransitionFinalized) {
        settleContinuationFailure(parent.responseId, advanced, deps.responseSessions);
      } else if (parent === undefined && stored && sessionPersisted && advanced) {
        settleNewStoredFailure(responseId, target.id, deps.responseSessions);
      } else if (parent === undefined && stored && !sessionPersisted && workspacePath !== undefined) {
        cleanupAbandoned = true;
      }
    }
    if (error instanceof OpenAIError) throw error;
    throw error;
  } finally {
    await releaseWorkspace(cleanupAbandoned);
  }
}

function failResponseOwner(
  deps: ResponsesDependencies,
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

export async function handleResponseStream(
  reply: FastifyReply,
  clientId: string,
  body: unknown,
  deps: ResponsesDependencies,
  attempt: OpenAIRunAttempt,
  idempotencyKey?: string,
): Promise<void> {
  const request = parseRequest(body);
  const target = authorizeTarget(clientId, request.model, deps, attempt);
  const outputSchema = responseToolBridge(request, target.toolBridge);
  const input = inputItems(request);
  const responseId = `resp_${randomUUID()}`;
  attempt.setResponseId(responseId);
  const outputId = `msg_${randomUUID()}`;
  let decision: IdempotencyDecision | undefined;
  let ownerSettled = false;

  if (idempotencyKey !== undefined) {
    if (!deps.idempotency) throw new Error('idempotency_service_unavailable');
    try {
      const runId = reserveRunId();
      decision = deps.idempotency.begin({
        clientId,
        key: idempotencyKey,
        endpoint: 'responses',
        request: body,
        runId,
        responseId,
        run: {
          clientId,
          extensionId: OPENAI_EXTENSION_ID,
          targetId: target.id,
          endpoint: 'responses',
          responseId,
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
      let response: OpenAIResponse;
      try {
        response = deserializeOpenAIReplay<OpenAIResponse>(await deps.idempotency.attach(decision));
      } catch (error) {
        if (error instanceof OpenAIError) throw error;
        throw new OpenAIError(409, 'Idempotency replay is unavailable', 'invalid_request_error', null, 'idempotency_replay_unavailable');
      }
      try {
        await writeResponsesStream(reply, replayResponseEvents(response), {
          responseId: response.id,
          outputId: response.output[0]!.id,
          model: response.model,
          outputSchema,
          ...(response.output.some((item) => item.type === 'function_call')
            ? {
                replayToolItems: response.output
                  .filter((item) => item.type === 'function_call')
                  .map((item) => ({ id: item.id, callId: item.call_id })),
              }
            : {}),
          onSessionStarted: () => {},
        });
      } catch (error) {
        if (!reply.raw.headersSent) throw error;
      }
      return;
    }
  }

  try {
    await executeResponseStream(
      reply,
      clientId,
      request,
      target,
      responseId,
      outputId,
      input,
      outputSchema,
      deps,
      decision?.type === 'owner' ? decision.runId : attempt.reserve(),
      decision?.type === 'owner'
        ? (response) => {
            deps.idempotency!.complete(decision, serializeOpenAISuccess(response));
            ownerSettled = true;
          }
        : undefined,
    );
  } catch (error) {
    if (!ownerSettled) failResponseOwner(deps, decision, attempt, error);
    if (!reply.raw.headersSent) throw error;
  }
}
