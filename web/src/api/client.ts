import type {
  AdminSessionResponse,
  GatewayErrorBody,
  WebUiAuthMode,
  WebUiAuthModeResponse,
} from './types.js';

export const CSRF_STORAGE_KEY = 'asq_gateway_csrf';
let webUiAuthMode: WebUiAuthMode = 'token';

export class GatewayHttpError extends Error {
  private constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayHttpError';
  }

  static async from(response: Response): Promise<GatewayHttpError> {
    let body: GatewayErrorBody = {};
    try {
      body = await response.json() as GatewayErrorBody;
    } catch {
      // Non-JSON errors still retain the HTTP status without exposing response text.
    }
    return new GatewayHttpError(
      response.status,
      body.error?.code ?? 'gateway_request_failed',
      body.error?.message ?? `Gateway request failed (${response.status})`,
    );
  }

  static csrfRequired(): GatewayHttpError {
    return new GatewayHttpError(401, 'admin_csrf_required', 'admin CSRF token required');
  }
}

export function storeCsrf(csrfToken: string): void {
  window.sessionStorage.setItem(CSRF_STORAGE_KEY, csrfToken);
}

export function clearCsrf(): void {
  window.sessionStorage.removeItem(CSRF_STORAGE_KEY);
}

function requireCsrf(): string {
  const csrfToken = window.sessionStorage.getItem(CSRF_STORAGE_KEY);
  if (!csrfToken) throw GatewayHttpError.csrfRequired();
  return csrfToken;
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin' });
  if (!response.ok) throw await GatewayHttpError.from(response);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (webUiAuthMode === 'token') headers.set('x-csrf-token', requireCsrf());
  return requestJson<T>(path, { ...init, headers });
}

export async function loadWebUiAuthMode(): Promise<WebUiAuthMode> {
  const response = await requestJson<WebUiAuthModeResponse>('/admin/auth/mode', { method: 'GET' });
  if (response.mode !== 'disabled' && response.mode !== 'token') {
    throw new Error('invalid Web UI auth mode');
  }
  webUiAuthMode = response.mode;
  return response.mode;
}

export function exchangeBootstrapCode(code: string): Promise<AdminSessionResponse> {
  return requestJson('/admin/bootstrap/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export function rotateCsrf(): Promise<AdminSessionResponse> {
  return adminFetch('/admin/session/csrf', { method: 'POST' });
}

export async function logoutAdminSession(): Promise<void> {
  try {
    await adminFetch<void>('/admin/session/logout', { method: 'POST' });
  } finally {
    window.sessionStorage.clear();
  }
}
