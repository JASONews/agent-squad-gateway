import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { gatewayErrorResponse, jsonResponse } from '../../web/src/test/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();

async function seedSensitiveCaches(): Promise<void> {
  queryClient.setQueryData(['sensitive-query'], { api_key: 'query-secret' });
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationFn: async () => ({ api_key: 'mutation-secret' }),
  });
  await mutation.execute(undefined);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/health') return jsonResponse({ ok: true, version: '0.1.0', db_ok: true });
    if (path === '/admin/core/health') return jsonResponse({ ok: true, version: '0.1.0' });
    if (path.startsWith('/admin/runs')) return jsonResponse({ runs: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  queryClient.clear();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Gateway admin session shell', () => {
  it('enters the Web UI without a token when authentication is disabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ mode: 'disabled' }));

    render(<GatewayRoot />);

    await screen.findByRole('navigation', { name: 'Gateway' });
    expect(screen.getByText('Web UI auth disabled')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'End local session' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('asq_gateway_csrf')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => input === '/admin/session/csrf')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => input === '/admin/bootstrap/exchange')).toBe(false);
  });

  it('switches the Web UI language and persists the user preference', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(jsonResponse({ mode: 'disabled' }));

    render(<GatewayRoot />);

    await screen.findByRole('navigation', { name: 'Gateway' });
    const language = screen.getByRole('combobox', { name: 'Language' });
    await user.selectOptions(language, 'zh-CN');

    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN');
    expect(localStorage.getItem('asq_gateway_language')).toBe('zh-CN');
    expect(screen.getByRole('link', { name: '概览' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');

    await user.selectOptions(screen.getByRole('combobox', { name: '语言' }), 'en');

    expect(document.documentElement).toHaveAttribute('lang', 'en');
    expect(localStorage.getItem('asq_gateway_language')).toBe('en');
    expect(screen.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  it('exchanges a fragment bootstrap code and keeps CSRF out of persistent storage', async () => {
    window.location.hash = '#/bootstrap/code_1';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ mode: 'token' }))
      .mockResolvedValueOnce(jsonResponse({
        csrf_token: 'csrf_bootstrap',
        expires_at: '2026-07-13T12:00:00.000Z',
      }));

    render(<GatewayRoot />);

    await screen.findByRole('navigation', { name: 'Gateway' });
    expect(sessionStorage.getItem('asq_gateway_csrf')).toBe('csrf_bootstrap');
    expect(localStorage.length).toBe(0);
    expect(window.location.hash).toBe('#/overview');
    expect(fetchMock).toHaveBeenCalledWith('/admin/bootstrap/exchange', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ code: 'code_1' }),
    }));
    const init = fetchMock.mock.calls.find(([input]) => input === '/admin/bootstrap/exchange')?.[1];
    expect(new Headers(init?.headers).has('x-csrf-token')).toBe(false);
    expect(document.body).not.toHaveTextContent(/admin secret/i);
  });

  it('scrubs a bootstrap code before a rejected exchange and leaves it out of the URL', async () => {
    window.location.hash = '#/bootstrap/code_rejected';
    let hashAtExchange = '';
    fetchMock.mockResolvedValueOnce(jsonResponse({ mode: 'token' }));
    fetchMock.mockImplementationOnce(() => {
      hashAtExchange = window.location.hash;
      return Promise.reject(new Error('exchange unavailable'));
    });

    render(<GatewayRoot />);

    expect(await screen.findByRole('status')).toHaveTextContent('Unavailable');
    expect(hashAtExchange).toBe('#/overview');
    expect(window.location.hash).toBe('#/overview');
    expect(fetchMock).toHaveBeenCalledWith('/admin/bootstrap/exchange', expect.objectContaining({
      body: JSON.stringify({ code: 'code_rejected' }),
    }));
  });

  it('rotates CSRF with the current in-tab token on ordinary startup', async () => {
    sessionStorage.setItem('asq_gateway_csrf', 'stale_csrf');
    window.location.hash = '#/overview';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ mode: 'token' }))
      .mockResolvedValueOnce(jsonResponse({
        csrf_token: 'csrf_rotated',
        expires_at: '2026-07-13T12:00:00.000Z',
      }));

    render(<GatewayRoot />);

    await screen.findByRole('navigation', { name: 'Gateway' });
    expect(sessionStorage.getItem('asq_gateway_csrf')).toBe('csrf_rotated');
    expect(fetchMock).toHaveBeenCalledWith('/admin/session/csrf', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    const init = fetchMock.mock.calls.find(([input]) => input === '/admin/session/csrf')?.[1];
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('stale_csrf');
  });

  it('renders locked without attempting cookie-only recovery when the in-tab token is absent', async () => {
    window.location.hash = '#/overview';

    render(<GatewayRoot />);

    expect(await screen.findByRole('status')).toHaveTextContent('Locked');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/admin/auth/mode');
  });

  it('sends the rotated CSRF token on protected admin reads', async () => {
    sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ mode: 'token' }))
      .mockResolvedValueOnce(jsonResponse({
        csrf_token: 'csrf_rotated',
        expires_at: '2026-07-13T12:00:00.000Z',
      }));

    render(<GatewayRoot />);

    await screen.findByRole('navigation', { name: 'Gateway' });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => input === '/admin/core/health')).toBe(true));
    const readCall = fetchMock.mock.calls.find(([input]) => input === '/admin/core/health');
    expect(new Headers(readCall?.[1]?.headers).get('x-csrf-token')).toBe('csrf_rotated');
  });

  it('renders the locked screen and clears transient CSRF after a 401', async () => {
    sessionStorage.setItem('asq_gateway_csrf', 'stale_csrf');
    sessionStorage.setItem('transient_page_state', 'remove-me');
    await seedSensitiveCaches();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ mode: 'token' }))
      .mockResolvedValueOnce(gatewayErrorResponse(
        401,
        'admin_session_required',
        'admin session required',
      ));

    render(<GatewayRoot />);

    expect(await screen.findByRole('status')).toHaveTextContent('Locked');
    expect(screen.getByRole('button', { name: 'Local session required' })).toBeDisabled();
    expect(screen.queryByRole('navigation', { name: 'Gateway' })).not.toBeInTheDocument();
    expect(sessionStorage.length).toBe(0);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it('logs out with CSRF, clears session storage, and returns to the locked screen', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem('asq_gateway_csrf', 'stale_csrf');
    sessionStorage.setItem('transient_page_state', 'remove-me');
    await seedSensitiveCaches();
    fetchMock.mockImplementation(async (input) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
      if (path === '/admin/session/csrf') return jsonResponse({
        csrf_token: 'csrf_rotated',
        expires_at: '2026-07-13T12:00:00.000Z',
      });
      if (path === '/admin/session/logout') return new Response(null, { status: 204 });
      if (path === '/health') return jsonResponse({ ok: true, version: '0.1.0', db_ok: true });
      if (path === '/admin/core/health') return jsonResponse({ ok: true, version: '0.1.0' });
      if (path.startsWith('/admin/runs')) return jsonResponse({ runs: [] });
      throw new Error(`Unexpected request: ${path}`);
    });

    render(<GatewayRoot />);
    await screen.findByRole('navigation', { name: 'Gateway' });
    await user.click(screen.getByRole('button', { name: 'End local session' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Locked'));
    expect(sessionStorage.length).toBe(0);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith('/admin/session/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    const logoutCall = fetchMock.mock.calls.find(([input]) => input === '/admin/session/logout');
    const init = logoutCall?.[1];
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf_rotated');
  });
});
