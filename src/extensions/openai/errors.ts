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

export function providerFailureError(
  code: string,
  param: 'messages' | 'input',
): OpenAIError {
  switch (code) {
    case 'image_input_invalid':
      return new OpenAIError(400, 'Invalid image input', 'invalid_request_error', param, code);
    case 'image_input_not_supported':
      return new OpenAIError(400, 'The selected model does not support image input', 'invalid_request_error', param, code);
    case 'image_limit_exceeded':
      return new OpenAIError(413, 'The image input limit was exceeded', 'invalid_request_error', param, code);
    case 'image_too_large':
      return new OpenAIError(413, 'An input image is too large', 'invalid_request_error', param, code);
    case 'image_fetch_failed':
      return new OpenAIError(400, 'An input image could not be fetched', 'invalid_request_error', param, code);
    case 'image_fetch_timeout':
      return new OpenAIError(504, 'Fetching an input image timed out', 'server_error', param, code);
    case 'image_cleanup_failed':
      return new OpenAIError(500, 'Image input cleanup failed', 'server_error', null, code);
    default:
      return new OpenAIError(502, 'The provider could not complete the request', 'server_error', null, 'provider_error');
  }
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
