import type { FastifyReply } from 'fastify';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
}

export class OpenAIError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type: string,
    readonly param: string | null,
    readonly code: string,
  ) {
    super(message);
  }

  toBody(): OpenAIErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

interface OpenAIReplayError {
  status: number;
  message: string;
  type: string;
  param: string | null;
  code: string;
}

type OpenAIReplayEnvelope<T> =
  | { ok: true; value: T }
  | { ok: false; error: OpenAIReplayError };

export function normalizeOpenAIError(error: unknown): OpenAIError {
  return error instanceof OpenAIError
    ? error
    : new OpenAIError(500, 'The server encountered an internal error', 'server_error', null, 'internal_error');
}

export function serializeOpenAISuccess<T>(value: T): string {
  return JSON.stringify({ ok: true, value } satisfies OpenAIReplayEnvelope<T>);
}

export function serializeOpenAIFailure(error: unknown): string {
  const safe = normalizeOpenAIError(error);
  return JSON.stringify({
    ok: false,
    error: {
      status: safe.status,
      message: safe.message,
      type: safe.type,
      param: safe.param,
      code: safe.code,
    },
  } satisfies OpenAIReplayEnvelope<never>);
}

export function deserializeOpenAIReplay<T>(chunks: string[]): T {
  if (chunks.length !== 1) throw new Error('invalid_idempotency_replay');
  const envelope = JSON.parse(chunks[0]!) as OpenAIReplayEnvelope<T>;
  if (envelope.ok) return envelope.value;
  throw new OpenAIError(
    envelope.error.status,
    envelope.error.message,
    envelope.error.type,
    envelope.error.param,
    envelope.error.code,
  );
}

export function sendOpenAIError(reply: FastifyReply, error: unknown): FastifyReply {
  const safeError = normalizeOpenAIError(error);
  if (safeError.status === 401) reply.header('www-authenticate', 'Bearer');
  return reply.code(safeError.status).send(safeError.toBody());
}
