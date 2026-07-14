import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { ProviderEvent } from '../../provider-runtime/types.js';
import { normalizeOpenAIError, OpenAIError } from './errors.js';
import {
  AdapterProtocolError,
  assignGatewayCallIds,
  StructuredEnvelopeDecoder,
  type DecodedToolCall,
  type ToolOutputSchema,
} from './tools.js';

const HEARTBEAT_MS = 15_000;

export interface ChatStreamMeta {
  id: string;
  created: number;
  model: string;
  outputSchema: ToolOutputSchema | null;
  replayCallIds?: string[];
  beforeTerminal?: (result: StreamResult) => void | Promise<void>;
}

export interface ResponsesStreamMeta {
  responseId: string;
  outputId: string;
  model: string;
  outputSchema: ToolOutputSchema | null;
  replayToolItems?: Array<{ id: string; callId: string }>;
  onSessionStarted: (nativeSessionId: string) => void;
  beforeTerminal?: (result: StreamResult) => void | Promise<void>;
}

export interface StreamResult {
  text: string;
  toolCalls?: Array<DecodedToolCall & { id: string; itemId?: string }>;
  nativeSessionId?: string;
  nativeStateAdvanced: boolean;
}

export class StreamDisconnectedError extends Error {
  constructor() {
    super('stream_disconnected');
  }
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
  return new OpenAIError(502, 'The provider could not complete the request', 'server_error', null, 'provider_error');
}

function cancelledError(): OpenAIError {
  return new OpenAIError(500, 'The request was cancelled', 'server_error', null, 'request_cancelled');
}

interface SseConnection {
  event(data: unknown): Promise<void>;
  comment(value: string): Promise<void>;
  disconnected: Promise<never>;
  close(): Promise<void>;
  cleanup(): void;
}

function openSse(reply: FastifyReply): SseConnection {
  reply.hijack();
  const raw = reply.raw;
  let ending = false;
  let disconnected = false;
  let disconnect!: (error: StreamDisconnectedError) => void;
  const disconnectedPromise = new Promise<never>((_resolve, reject) => { disconnect = reject; });
  void disconnectedPromise.catch(() => undefined);

  const markDisconnected = () => {
    if (ending || disconnected) return;
    disconnected = true;
    disconnect(new StreamDisconnectedError());
  };
  raw.once('close', markDisconnected);
  raw.once('error', markDisconnected);
  reply.request.raw.once('aborted', markDisconnected);

  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders();

  const waitForDrain = (): Promise<void> => new Promise((resolve, reject) => {
    const onDrain = () => finish();
    const onClose = () => finish(new StreamDisconnectedError());
    const onAborted = () => finish(new StreamDisconnectedError());
    const finish = (error?: Error) => {
      raw.off('drain', onDrain);
      raw.off('close', onClose);
      raw.off('error', onClose);
      reply.request.raw.off('aborted', onAborted);
      if (error) reject(error);
      else resolve();
    };
    raw.once('drain', onDrain);
    raw.once('close', onClose);
    raw.once('error', onClose);
    reply.request.raw.once('aborted', onAborted);
    if (disconnected || raw.destroyed) finish(new StreamDisconnectedError());
  });

  let tail = Promise.resolve();
  const enqueue = (frame: string): Promise<void> => {
    const write = tail.then(async () => {
      if (disconnected || raw.destroyed) throw new StreamDisconnectedError();
      if (!raw.write(frame)) await waitForDrain();
    });
    tail = write.catch(() => undefined);
    return write;
  };

  const heartbeat = setInterval(() => {
    void enqueue(': heartbeat\n\n').catch(markDisconnected);
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    raw.off('close', markDisconnected);
    raw.off('error', markDisconnected);
    reply.request.raw.off('aborted', markDisconnected);
  };

  return {
    event: (data) => enqueue(`data: ${data === '[DONE]' ? data : JSON.stringify(data)}\n\n`),
    comment: (value) => enqueue(`: ${value}\n\n`),
    disconnected: disconnectedPromise,
    close: async () => {
      if (ending || disconnected) return;
      ending = true;
      cleanup();
      await tail;
      raw.end();
    },
    cleanup,
  };
}

function chatChunk(
  meta: ChatStreamMeta,
  delta: {
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index: number;
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  },
  finishReason: 'stop' | 'tool_calls' | null,
): Record<string, unknown> {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function nextEvent(
  iterator: AsyncIterator<ProviderEvent>,
  connection: SseConnection,
): Promise<IteratorResult<ProviderEvent>> {
  return Promise.race([iterator.next(), connection.disconnected]);
}

async function returnIterator(iterator: AsyncIterator<ProviderEvent>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Connection cleanup is best effort after the public stream result is fixed.
  }
}

export async function writeChatStream(
  reply: FastifyReply,
  events: AsyncIterable<ProviderEvent>,
  meta: ChatStreamMeta,
): Promise<StreamResult> {
  const connection = openSse(reply);
  const iterator = events[Symbol.asyncIterator]();
  let text = '';
  let terminalSeen = false;
  let finished = false;
  let finalizationFailed = false;
  const decoder = meta.outputSchema === null ? undefined : new StructuredEnvelopeDecoder(meta.outputSchema);
  let toolCalls: Array<DecodedToolCall & { id: string }> | undefined;

  try {
    await connection.event(chatChunk(meta, { role: 'assistant' }, null));
    while (true) {
      const next = await nextEvent(iterator, connection);
      if (next.done) break;
      if (terminalSeen) throw protocolError();
      const event = next.value;
      switch (event.type) {
        case 'session_started':
          break;
        case 'text_delta':
          if (decoder) throw protocolError();
          text += event.delta;
          await connection.event(chatChunk(meta, { content: event.delta }, null));
          break;
        case 'structured_delta':
          if (!decoder) throw protocolError();
          try {
            const delta = decoder.push(event.delta);
            if (delta.length > 0) {
              text += delta;
              await connection.event(chatChunk(meta, { content: delta }, null));
            }
          } catch (error) {
            if (error instanceof AdapterProtocolError) throw protocolError();
            throw error;
          }
          break;
        case 'completed':
          terminalSeen = true;
          break;
        case 'failed':
          throw event.code === 'adapter_protocol_error' ? protocolError() : providerError();
        case 'cancelled':
          throw cancelledError();
        default:
          throw protocolError();
      }
    }
    if (!terminalSeen) throw protocolError();
    if (decoder) {
      try {
        const decoded = decoder.finish();
        if (decoded.type === 'tool_calls') {
          if (meta.replayCallIds !== undefined) {
            if (meta.replayCallIds.length !== decoded.toolCalls.length) throw protocolError();
            toolCalls = decoded.toolCalls.map((call, index) => ({ ...call, id: meta.replayCallIds![index]! }));
          } else {
            toolCalls = assignGatewayCallIds(decoded.toolCalls);
          }
          await connection.event(chatChunk(meta, {
            tool_calls: toolCalls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }, null));
        }
      } catch (error) {
        if (error instanceof AdapterProtocolError) throw protocolError();
        throw error;
      }
    }
    const result = { text, toolCalls, nativeStateAdvanced: false };
    try {
      await meta.beforeTerminal?.(result);
    } catch (error) {
      finalizationFailed = true;
      throw error;
    }
    await connection.event(chatChunk(meta, {}, toolCalls ? 'tool_calls' : 'stop'));
    await connection.event('[DONE]');
    await connection.close();
    finished = true;
    return result;
  } catch (error) {
    if (!(error instanceof StreamDisconnectedError)) {
      try {
        await connection.event(normalizeOpenAIError(error).toBody());
        if (!finalizationFailed) await connection.event('[DONE]');
        await connection.close();
      } catch {
        // The socket may disappear while the safe error is being written.
      }
    }
    throw error;
  } finally {
    connection.cleanup();
    if (!finished) await returnIterator(iterator);
  }
}

function responseState(
  id: string,
  model: string,
  status: 'in_progress' | 'completed',
  output: unknown[],
  outputText?: string,
): Record<string, unknown> {
  return {
    id,
    object: 'response',
    status,
    model,
    output,
    ...(outputText === undefined ? {} : { output_text: outputText }),
  };
}

export async function writeResponsesStream(
  reply: FastifyReply,
  events: AsyncIterable<ProviderEvent>,
  meta: ResponsesStreamMeta,
): Promise<StreamResult> {
  const connection = openSse(reply);
  const iterator = events[Symbol.asyncIterator]();
  let text = '';
  let nativeSessionId: string | undefined;
  let nativeStateAdvanced = false;
  let terminalSeen = false;
  let sequence = 0;
  let finished = false;
  const decoder = meta.outputSchema === null ? undefined : new StructuredEnvelopeDecoder(meta.outputSchema);
  let toolCalls: Array<DecodedToolCall & { id: string; itemId: string }> | undefined;

  const emit = (data: Record<string, unknown>) => connection.event({ ...data, sequence_number: sequence++ });
  try {
    const inProgress = responseState(meta.responseId, meta.model, 'in_progress', []);
    await emit({ type: 'response.created', response: inProgress });
    await emit({ type: 'response.in_progress', response: inProgress });
    while (true) {
      const next = await nextEvent(iterator, connection);
      if (next.done) break;
      if (terminalSeen) throw protocolError();
      const event = next.value;
      switch (event.type) {
        case 'session_started':
          if (nativeSessionId !== undefined) throw protocolError();
          nativeSessionId = event.nativeSessionId;
          nativeStateAdvanced = true;
          meta.onSessionStarted(nativeSessionId);
          break;
        case 'text_delta':
          if (nativeSessionId === undefined) throw protocolError();
          if (decoder) throw protocolError();
          text += event.delta;
          await emit({
            type: 'response.output_text.delta', item_id: meta.outputId,
            output_index: 0, content_index: 0, delta: event.delta,
          });
          break;
        case 'structured_delta':
          if (nativeSessionId === undefined || !decoder) throw protocolError();
          try {
            const delta = decoder.push(event.delta);
            if (delta.length > 0) {
              text += delta;
              await emit({
                type: 'response.output_text.delta', item_id: meta.outputId,
                output_index: 0, content_index: 0, delta,
              });
            }
          } catch (error) {
            if (error instanceof AdapterProtocolError) throw protocolError();
            throw error;
          }
          break;
        case 'completed':
          if (nativeSessionId === undefined) throw protocolError();
          terminalSeen = true;
          break;
        case 'failed':
          nativeStateAdvanced ||= event.nativeStateAdvanced;
          throw event.code === 'adapter_protocol_error' ? protocolError() : providerError();
        case 'cancelled':
          throw cancelledError();
        default:
          throw protocolError();
      }
    }
    if (!terminalSeen || nativeSessionId === undefined) throw protocolError();
    if (decoder) {
      try {
        const decoded = decoder.finish();
        if (decoded.type === 'tool_calls') {
          const calls = meta.replayToolItems === undefined
            ? assignGatewayCallIds(decoded.toolCalls).map((call) => ({ ...call, itemId: `fc_${randomUUID()}` }))
            : decoded.toolCalls.map((call, index) => {
                const replay = meta.replayToolItems![index];
                if (!replay || meta.replayToolItems!.length !== decoded.toolCalls.length) throw protocolError();
                return { ...call, id: replay.callId, itemId: replay.id };
              });
          toolCalls = calls;
          for (const [outputIndex, call] of calls.entries()) {
            await emit({
              type: 'response.output_item.added',
              output_index: outputIndex,
              item: {
                id: call.itemId, type: 'function_call', status: 'in_progress',
                arguments: '', call_id: call.id, name: call.name,
              },
            });
          }
        }
      } catch (error) {
        if (error instanceof AdapterProtocolError) throw protocolError();
        throw error;
      }
    }
    const output = toolCalls
      ? toolCalls.map((call) => ({
          id: call.itemId,
          type: 'function_call',
          status: 'completed',
          arguments: JSON.stringify(call.arguments),
          call_id: call.id,
          name: call.name,
        }))
      : [{
          id: meta.outputId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        }];
    const result = { text, toolCalls, nativeSessionId, nativeStateAdvanced };
    await meta.beforeTerminal?.(result);
    if (toolCalls) {
      for (const [outputIndex, call] of toolCalls.entries()) {
        const item = output[outputIndex]!;
        await emit({
          type: 'response.function_call_arguments.done',
          item_id: call.itemId,
          output_index: outputIndex,
          arguments: JSON.stringify(call.arguments),
        });
        await emit({ type: 'response.output_item.done', output_index: outputIndex, item });
      }
    } else {
      await emit({
        type: 'response.output_text.done', item_id: meta.outputId,
        output_index: 0, content_index: 0, text,
      });
    }
    await emit({
      type: 'response.completed',
      response: responseState(meta.responseId, meta.model, 'completed', output, text),
    });
    await connection.close();
    finished = true;
    return result;
  } catch (error) {
    if (typeof error === 'object' && error !== null) Object.assign(error, { nativeStateAdvanced });
    if (!(error instanceof StreamDisconnectedError)) {
      try {
        await emit({ type: 'error', ...normalizeOpenAIError(error).toBody() });
        await connection.close();
      } catch {
        // The socket may disappear while the safe error is being written.
      }
    }
    throw error;
  } finally {
    connection.cleanup();
    if (!finished) await returnIterator(iterator);
  }
}
