import { z, type ZodType } from 'zod';
import type {
  AgentSquadCoreEvent,
  CoreChoice,
  CoreChoiceOption,
  CoreChoiceRecommendation,
  CoreDebugBundle,
  CoreHealth,
  CoreMessage,
  CoreSession,
  CoreSubagent,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 2_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const healthSchema = z.object({ ok: z.boolean(), version: z.string(), db_ok: z.boolean() });
const sessionSchema = z.object({
  id: z.string(), root_task: z.string(), repo_path: z.string().nullable(),
  main_peer_id: z.string().nullable(), created_at: z.string(), updated_at: z.string(),
});
const subagentSchema = z.object({
  id: z.string(), alias: z.string(), cli_type: z.string(), role: z.string(), status: z.string(),
  native_session_id: z.string().nullable(), cwd: z.string().nullable(), model: z.string().nullable(),
  reasoning_effort: z.string().nullable(), last_seen_at: z.string(), raw_tail: z.string().nullable(),
});
const messageSchema = z.object({
  id: z.string(), session_id: z.string(), from_peer_id: z.string().nullable(),
  to_peer_id: z.string().nullable(), kind: z.string(), content: z.string().nullable(),
  artifact_refs: z.string().nullable(), created_at: z.string(),
});
const choiceOptionSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), tradeoff: z.string().optional(),
}).strict();
const choiceRecommendationSchema = z.object({
  option_id: z.string().min(1), reason: z.string().min(1), confidence: z.enum(['low', 'medium', 'high']).optional(),
}).strict();
const choiceStatusSchema = z.enum(['pending_main_agent', 'resolved', 'expired', 'cancelled']);
const rawChoiceSchema = z.object({
  id: z.string(), session_id: z.string(), requester_subagent_id: z.string(), target_peer_id: z.string().nullable(),
  question: z.string(), options_json: z.string(), recommendation_json: z.string().nullable(),
  status: choiceStatusSchema, selected: z.string().nullable(), rationale: z.string().nullable(),
  created_at: z.string(), resolved_at: z.string().nullable(),
});
const coreEventSchema = z.object({ type: z.string().min(1), payload: z.record(z.unknown()) });

export type CoreClientErrorCode =
  | 'core_offline'
  | 'core_timeout'
  | 'core_protocol_error'
  | 'core_upstream_error'
  | 'core_request_aborted'
  | 'core_session_not_found';

export class CoreClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: CoreClientErrorCode,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'CoreClientError';
  }
}

export interface CoreClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export function parseCoreBaseUrl(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input !== input.trim()) {
    throw new Error('invalid_core_url');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('invalid_core_url');
  }
  if (url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== '') {
    throw new Error('invalid_core_url');
  }
  return url.origin;
}

export class CoreClient {
  baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;

  constructor(baseUrl: string, options: CoreClientOptions = {}) {
    this.baseUrl = parseCoreBaseUrl(baseUrl);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = parseCoreBaseUrl(baseUrl);
  }

  health(signal?: AbortSignal): Promise<CoreHealth> {
    return this.read('/v1/health', healthSchema, signal);
  }

  async listSessions(signal?: AbortSignal): Promise<CoreSession[]> {
    return (await this.read('/v1/sessions', z.object({ sessions: z.array(sessionSchema) }), signal)).sessions;
  }

  async listSubagents(sessionId: string, signal?: AbortSignal): Promise<CoreSubagent[]> {
    const id = encodeURIComponent(sessionId);
    return (await this.read(`/v1/sessions/${id}/subagents`, z.object({ subagents: z.array(subagentSchema) }), signal)).subagents;
  }

  async listMessages(sessionId: string, limit?: number, signal?: AbortSignal): Promise<CoreMessage[]> {
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new CoreClientError(400, 'core_protocol_error', 'invalid Core message limit');
    }
    const id = encodeURIComponent(sessionId);
    const query = limit === undefined ? '' : `?limit=${limit}`;
    return (await this.read(`/v1/sessions/${id}/messages${query}`, z.object({ messages: z.array(messageSchema) }), signal)).messages;
  }

  async listChoices(sessionId: string, signal?: AbortSignal): Promise<CoreChoice[]> {
    const id = encodeURIComponent(sessionId);
    const rows = (await this.read(`/v1/sessions/${id}/choices`, z.object({ choices: z.array(rawChoiceSchema) }), signal)).choices;
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      requester_subagent_id: row.requester_subagent_id,
      target_peer_id: row.target_peer_id,
      question: row.question,
      options: parseEmbeddedJson(row.options_json, z.array(choiceOptionSchema)),
      recommendation: row.recommendation_json === null
        ? null
        : parseEmbeddedJson(row.recommendation_json, choiceRecommendationSchema),
      status: row.status,
      selected: row.selected,
      rationale: row.rationale,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
    }));
  }

  async getSessionDebug(sessionId: string, signal?: AbortSignal): Promise<CoreDebugBundle> {
    const session = (await this.listSessions(signal)).find((candidate) => candidate.id === sessionId);
    if (!session) throw new CoreClientError(404, 'core_session_not_found', 'Core session not found');
    const [subagents, messages, choices] = await Promise.all([
      this.listSubagents(sessionId, signal),
      this.listMessages(sessionId, undefined, signal),
      this.listChoices(sessionId, signal),
    ]);
    return { session, subagents, messages, choices };
  }

  async resolveChoice(
    sessionId: string,
    choiceId: string,
    selected: string,
    rationale?: string,
  ): Promise<void> {
    const session = encodeURIComponent(sessionId);
    const choice = encodeURIComponent(choiceId);
    await this.requestJson(
      `/v1/sessions/${session}/choices/${choice}/resolve`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ selected, ...(rationale === undefined ? {} : { rationale }) }) },
      z.object({ status: z.literal('resolved') }),
    );
  }

  async *events(signal: AbortSignal): AsyncIterable<AgentSquadCoreEvent> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/v1/events`, {
        method: 'GET', headers: { accept: 'text/event-stream' }, signal,
      });
    } catch (error) {
      throw normalizeFetchError(error, signal.aborted, false);
    }
    if (!response.ok) throw await upstreamError(response);
    if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      throw protocolError();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const event = parseSseFrame(frame);
          if (event) yield event;
        }
        if (done) break;
      }
      const final = parseSseFrame(buffer);
      if (final) yield final;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CoreClientError) throw error;
      throw protocolError();
    } finally {
      reader.releaseLock();
    }
  }

  private read<T>(path: string, schema: ZodType<T>, signal?: AbortSignal): Promise<T> {
    return this.requestJson(path, { method: 'GET', signal }, schema);
  }

  private async requestJson<T>(path: string, init: RequestInit, schema: ZodType<T>): Promise<T> {
    const timeout = new AbortController();
    const timer = this.setTimeoutFn(() => timeout.abort(), this.timeoutMs);
    timer.unref?.();
    const callerSignal = init.signal ?? undefined;
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal;
    try {
      let response: Response;
      try {
        response = await this.fetchFn(`${this.baseUrl}${path}`, { ...init, signal });
      } catch (error) {
        throw normalizeFetchError(error, callerSignal?.aborted ?? false, timeout.signal.aborted);
      }
      if (!response.ok) throw await upstreamError(response);
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw normalizeFetchError(error, callerSignal?.aborted ?? false, timeout.signal.aborted);
      }
      let value: unknown;
      try {
        value = JSON.parse(body);
      } catch {
        throw protocolError();
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw protocolError();
      return parsed.data;
    } finally {
      this.clearTimeoutFn(timer);
    }
  }
}

function parseEmbeddedJson<T>(input: string, schema: ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw protocolError();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}

function parseSseFrame(frame: string): AgentSquadCoreEvent | undefined {
  const data = frame.split(/\r?\n/)
    .filter((line) => line === 'data' || line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (data.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw protocolError();
  }
  const parsed = coreEventSchema.safeParse(value);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}

async function upstreamError(response: Response): Promise<CoreClientError> {
  await response.body?.cancel().catch(() => undefined);
  return new CoreClientError(
    502,
    'core_upstream_error',
    'Core request failed',
    response.status,
  );
}

function normalizeFetchError(error: unknown, callerAborted: boolean, timedOut: boolean): CoreClientError {
  if (timedOut) return new CoreClientError(504, 'core_timeout', 'Core request timed out');
  if (callerAborted) return new CoreClientError(499, 'core_request_aborted', 'Core request aborted');
  if (error instanceof CoreClientError) return error;
  return new CoreClientError(503, 'core_offline', 'Core is offline');
}

function protocolError(): CoreClientError {
  return new CoreClientError(502, 'core_protocol_error', 'Core returned an invalid response');
}

export type { CoreChoiceOption, CoreChoiceRecommendation };
