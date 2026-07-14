import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminAuthService } from '../security/admin-auth.js';

const SESSION_COOKIE = 'asq_gateway_admin';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const VITE_DEV_ORIGIN = 'http://127.0.0.1:28773';
const COOKIE_ONLY_SSE_ROUTE = '/admin/core/events';

export function sessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;

  const values: string[] = [];
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values.length === 1 ? values[0] : undefined;
}

function sendAuthError(
  reply: FastifyReply,
  status: 401 | 403,
  code: 'admin_session_required' | 'csrf_invalid',
  message: string,
): void {
  reply.code(status).send({ error: { code, message } });
}

export function requireAdmin(
  adminAuth: AdminAuthService,
  configuredOrigins: string | ReadonlySet<string>,
  enabled = true,
) {
  const trustedOrigins = typeof configuredOrigins === 'string'
    ? new Set([configuredOrigins, VITE_DEV_ORIGIN])
    : configuredOrigins;

  return async function adminGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!enabled) return;
    const token = sessionCookie(request.headers.cookie);
    if (!token || !adminAuth.verifySession(token)) {
      sendAuthError(reply, 401, 'admin_session_required', 'admin session required');
      return;
    }

    if (request.method === 'GET' && request.routeOptions.url === COOKIE_ONLY_SSE_ROUTE) return;

    const origin = request.headers.origin;
    const csrfToken = request.headers['x-csrf-token'];
    if (typeof csrfToken !== 'string'
      || !adminAuth.verifySession(token, csrfToken)
      || (!SAFE_METHODS.has(request.method) && !trustedOrigins.has(origin ?? ''))) {
      sendAuthError(reply, 403, 'csrf_invalid', 'CSRF validation failed');
    }
  };
}
