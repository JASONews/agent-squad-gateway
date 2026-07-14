import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CoreConnectionRepository } from '../control-plane/core-connection.js';
import { CoreClientError, type CoreClient } from './client.js';

const HEARTBEAT_MS = 15_000;
const RECONNECT_DELAYS_MS = [250, 1_000, 2_000, 5_000] as const;

function invalidationEvent(event: { type: string; payload: Record<string, unknown> }) {
  const sessionId = event.payload.session_id;
  return {
    type: event.type,
    payload: typeof sessionId === 'string' ? { session_id: sessionId } : {},
  };
}

export interface CoreEventProxyOptions {
  heartbeatMs?: number;
  reconnectDelaysMs?: readonly number[];
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export async function proxyCoreEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  client: CoreClient,
  connection: CoreConnectionRepository,
  options: CoreEventProxyOptions = {},
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  const controller = new AbortController();
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  const delays = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : RECONNECT_DELAYS_MS;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
  };
  raw.once('close', close);
  raw.once('error', close);
  request.raw.once('aborted', close);
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders();

  const writeEvent = (event: unknown) => {
    if (!closed && !raw.destroyed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const writeConnection = (status: string, retryInMs?: number) => writeEvent({
    type: 'core_connection',
    payload: retryInMs === undefined ? { status } : { status, retryInMs },
  });
  writeConnection(connection.get().status);
  const heartbeat = setIntervalFn(() => {
    if (!closed && !raw.destroyed) raw.write(': heartbeat\n\n');
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  let attempt = 0;
  try {
    while (!controller.signal.aborted) {
      let receivedEvent = false;
      try {
        for await (const event of client.events(controller.signal)) {
          if (controller.signal.aborted) break;
          if (!receivedEvent) {
            receivedEvent = true;
            writeConnection('online');
          }
          if (event.type !== 'hello') attempt = 0;
          writeEvent(invalidationEvent(event));
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        const record = connection.markHealth(undefined);
        writeConnection(error instanceof CoreClientError ? 'offline' : record.status);
      }
      if (controller.signal.aborted) break;
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      attempt += 1;
      writeConnection('reconnecting', delay);
      await abortableDelay(delay, controller.signal, options);
    }
  } finally {
    clearIntervalFn(heartbeat);
    raw.off('close', close);
    raw.off('error', close);
    request.raw.off('aborted', close);
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
}

function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
  options: CoreEventProxyOptions,
): Promise<void> {
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeoutFn(finish, delayMs);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeoutFn(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
