import type { FastifyReply } from 'fastify';

export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }

  toBody(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function sendGatewayError(reply: FastifyReply, error: unknown): FastifyReply {
  const value = error instanceof GatewayError
    ? error
    : new GatewayError(500, 'internal_error', 'internal gateway error');
  return reply.code(value.status).send(value.toBody());
}
