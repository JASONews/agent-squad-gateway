import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CredentialService } from '../../control-plane/credentials.js';
import { OpenAIError } from './errors.js';

export interface OpenAIClientContext {
  clientId: string;
  credentialId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    openAIClient: OpenAIClientContext | null;
  }
}

export function requireOpenAIClient(credentials: CredentialService) {
  return async function authenticateOpenAIClient(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
    const authenticated = match?.[1] ? credentials.authenticate(match[1]) : null;
    if (!authenticated) {
      throw new OpenAIError(
        401,
        'Invalid authentication credentials',
        'invalid_request_error',
        null,
        'invalid_api_key',
      );
    }
    request.openAIClient = {
      clientId: authenticated.clientId,
      credentialId: authenticated.credentialId,
    };
  };
}
