import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { gatewayErrorResponse, jsonResponse } from '../../web/src/test/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();
const requests: Array<{ method: string; path: string; body: unknown }> = [];

const settings = {
  core: { base_url: 'http://127.0.0.1:28771', status: 'unknown', version: null, last_checked_at: null },
  bind_address: '0.0.0.0:28772',
  state_paths: {
    config: '/tmp/config.json', database: '/tmp/gateway.db',
    master_key: '/tmp/master.key', admin_secret: '/tmp/admin-secret',
  },
  retention: { metadata_days: 30, replay_ttl_minutes: 10 },
  security: { bind: 'all-interfaces', cors: 'disabled', web_ui_auth: 'token' },
};

const baseAvailability = [{
  cli: 'codex', scannedAt: '2026-07-13T12:00:00.000Z', verificationCount: 0,
  capabilities: {
    available: true, version: '1.2.0', verified: false, modelSelection: true,
    effortSelection: true, modelOptions: [{ id: 'gpt-5.6', label: 'GPT-5.6', effortOptions: ['high', 'max'] }],
    isolationLevel: 'best_effort', streamingMode: 'native', toolBridge: 'structured_output',
    resume: true, cancellation: true,
  },
}];
let availability = structuredClone(baseAvailability);
let coreOffline = false;

const progress = {
  core_configured: false, cli_scan_complete: false, target_count: 0, client_count: 0, credential_count: 0,
};

function pathOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function installApi(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = pathOf(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    requests.push({ method, path, body });
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/admin/session/csrf') {
      return jsonResponse({ csrf_token: 'csrf_rotated', expires_at: '2026-07-13T12:00:00.000Z' });
    }
    if (path === '/admin/settings' && method === 'GET') return jsonResponse(settings);
    if (path === '/admin/setup/status' && method === 'GET') return jsonResponse(progress);
    if (path === '/admin/settings/core' && method === 'PATCH') {
      if ((body as { base_url: string }).base_url.startsWith('https:')) {
        return gatewayErrorResponse(400, 'invalid_core_url', 'invalid control-plane request');
      }
      settings.core.base_url = (body as { base_url: string }).base_url;
      return jsonResponse({ base_url: settings.core.base_url });
    }
    if (path === '/admin/core/health') {
      progress.core_configured = true;
      if (coreOffline) return gatewayErrorResponse(502, 'core_offline', 'Core is unavailable');
      return jsonResponse({ ok: true, version: '0.1.0', connection: { status: 'online' } });
    }
    if (path === '/admin/cli-availability/refresh' && method === 'POST') {
      progress.cli_scan_complete = true;
      return jsonResponse({ cli_availability: availability });
    }
    if (path === '/admin/setup/client-credential' && method === 'POST') {
      progress.client_count = 1;
      progress.credential_count = 1;
      return jsonResponse({ id: 'credential_1', clientId: 'client_1', prefix: 'asqsk_setup', api_key: 'asqsk_setup_secret' }, 201);
    }
    if (path === '/admin/cli-availability' && method === 'GET') return jsonResponse({ cli_availability: availability });
    if (path === '/admin/targets' && method === 'POST') {
      progress.target_count += 1;
      return jsonResponse({ ...(body as object), enabled: false, capabilityVerifiedAt: null }, 201);
    }
    if (path === '/admin/credentials/credential_1/reveal') return jsonResponse({ api_key: 'asqsk_setup_secret' });
    if (path === '/admin/session/logout' && method === 'POST') return new Response(null, { status: 204 });
    if (path === '/health') return jsonResponse({ ok: true, version: '0.1.0', db_ok: true });
    if (path === '/admin/runs/overview') return jsonResponse({ runs: [], verifiedTargetCount: 0, activeRunCount: 0, queuePressure: [] });
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
}

function renderAt(path: string): void {
  window.location.hash = `#${path}`;
  render(<GatewayRoot />);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  queryClient.clear();
  requests.length = 0;
  progress.core_configured = false;
  progress.cli_scan_complete = false;
  progress.target_count = 0;
  progress.client_count = 0;
  progress.credential_count = 0;
  availability = structuredClone(baseAvailability);
  coreOffline = false;
  settings.core.base_url = 'http://127.0.0.1:28771';
  sessionStorage.clear();
  sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  installApi();
});

describe('Gateway first-run setup', () => {
  it('configures Core, scans CLIs, creates a client/key, then exits setup', async () => {
    const user = userEvent.setup();
    renderAt('/setup');

    const coreUrl = await screen.findByLabelText('Core URL');
    await user.clear(coreUrl);
    await user.type(coreUrl, 'http://127.0.0.1:28771');
    await user.click(screen.getByRole('button', { name: 'Check Core' }));
    await user.click(await screen.findByRole('button', { name: 'Scan CLIs' }));
    await user.type(screen.getByLabelText('Client name'), 'Local LiteLLM');
    await user.click(screen.getByRole('button', { name: 'Create client and key' }));

    expect(await screen.findByDisplayValue(/^asqsk_/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(window.location.hash).toBe('#/overview'));
    expect(localStorage.length).toBe(0);
  });

  it('keeps a generated API key out of query and mutation caches across route changes', async () => {
    const user = userEvent.setup();
    renderAt('/setup');

    await user.type(await screen.findByLabelText('Client name'), 'Ephemeral client');
    await user.click(screen.getByRole('button', { name: 'Create client and key' }));
    expect(await screen.findByDisplayValue('asqsk_setup_secret')).toBeVisible();

    const cachedState = () => ({
      queries: queryClient.getQueryCache().getAll().map((query) => query.state),
      mutations: queryClient.getMutationCache().getAll().map((mutation) => mutation.state),
    });
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
    expect(queryClient.getMutationCache().getAll()[0]?.state.data).toBeUndefined();
    expect(JSON.stringify(cachedState())).not.toContain('asqsk_setup_secret');

    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.queryByDisplayValue('asqsk_setup_secret')).not.toBeInTheDocument();
    expect(JSON.stringify(cachedState())).not.toContain('asqsk_setup_secret');
  });

  it('maps only latest model options and creates selected targets disabled and unverified', async () => {
    availability = [
      ...structuredClone(baseAvailability),
      { ...structuredClone(baseAvailability[0]!), cli: 'opencode', capabilities: { ...structuredClone(baseAvailability[0]!.capabilities), modelOptions: [{ id: 'anthropic/claude-sonnet', label: 'anthropic/claude-sonnet', effortOptions: null }] } },
      { ...structuredClone(baseAvailability[0]!), cli: 'claude', capabilities: { ...structuredClone(baseAvailability[0]!.capabilities), modelOptions: [{ id: 'default', label: 'Claude Code default', effortOptions: ['low', 'max'] }] } },
      { ...structuredClone(baseAvailability[0]!), cli: 'cursor', capabilities: { ...structuredClone(baseAvailability[0]!.capabilities), effortSelection: false, modelOptions: [{ id: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol 1M Max', effortOptions: null }] } },
      { ...structuredClone(baseAvailability[0]!), cli: 'antigravity', capabilities: { ...structuredClone(baseAvailability[0]!.capabilities), effortSelection: false, modelOptions: [{ id: 'short-id', label: 'Gemini 3.5 Pro (High)', effortOptions: null }] } },
    ];
    const user = userEvent.setup();
    renderAt('/setup');
    await user.click(await screen.findByRole('button', { name: 'Scan CLIs' }));

    const ids = [
      'codex-gpt-5.6-max',
      'opencode-anthropic-claude-sonnet',
      'claude-default-max',
      'cursor-gpt-5.6-sol-max',
      'antigravity-gemini-3.5-pro-high',
    ];
    for (const id of ids) await user.click(await screen.findByRole('switch', { name: `Select ${id}` }));
    await user.click(screen.getByRole('button', { name: 'Create selected targets' }));
    await waitFor(() => expect(requests.filter((request) => request.path === '/admin/targets')).toHaveLength(5));

    const targetBodies = requests.filter((request) => request.path === '/admin/targets').map((request) => request.body as Record<string, unknown>);
    expect(targetBodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-gpt-5.6-max', native_model: 'gpt-5.6', reasoning_effort: 'max' }),
      expect.objectContaining({ id: 'opencode-anthropic-claude-sonnet', native_model: 'anthropic/claude-sonnet', reasoning_effort: null }),
      expect.objectContaining({ id: 'claude-default-max', native_model: 'default', reasoning_effort: 'max' }),
      expect.objectContaining({ id: 'cursor-gpt-5.6-sol-max', native_model: 'gpt-5.6-sol-max', reasoning_effort: null }),
      expect.objectContaining({ id: 'antigravity-gemini-3.5-pro-high', native_model: 'Gemini 3.5 Pro (High)', reasoning_effort: null }),
    ]));
    for (const body of targetBodies) {
      expect(body).not.toHaveProperty('enabled');
      expect(body).not.toHaveProperty('capability_verified_at');
    }
    expect(requests.some((request) => request.path.includes('/verify') || request.path === '/admin/grants')).toBe(false);
  });

  it('allows Core skip and offline Core, and refreshes an empty CLI scan without model usage', async () => {
    availability = [{ ...structuredClone(baseAvailability[0]!), capabilities: { ...structuredClone(baseAvailability[0]!.capabilities), available: false, modelOptions: undefined } }];
    coreOffline = true;
    const user = userEvent.setup();
    renderAt('/setup');
    await user.click(await screen.findByRole('button', { name: 'Skip Core' }));
    await user.click(screen.getByRole('button', { name: 'Check Core' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Core is offline; setup can continue');
    await user.click(screen.getByRole('button', { name: 'Scan CLIs' }));
    expect(await screen.findByText('No installed CLIs found')).toBeVisible();
    expect(screen.getByText('No model usage')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh CLIs' }));
    await waitFor(() => expect(requests.filter((request) => request.path === '/admin/cli-availability/refresh')).toHaveLength(2));
    expect(requests.some((request) => request.path.includes('/verify'))).toBe(false);
  });

  it('resumes from server resource counts and rejects non-loopback Core URLs', async () => {
    progress.core_configured = true;
    progress.cli_scan_complete = true;
    progress.target_count = 2;
    progress.client_count = 1;
    progress.credential_count = 1;
    localStorage.setItem('setup_complete', 'false');
    const user = userEvent.setup();
    renderAt('/setup');

    const finish = await screen.findByRole('button', { name: 'Finish setup' });
    await waitFor(() => expect(finish).toBeEnabled());
    const coreUrl = screen.getByLabelText('Core URL');
    await user.clear(coreUrl);
    await user.type(coreUrl, 'https://example.com');
    await user.click(screen.getByRole('button', { name: 'Check Core' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Core URL must be a loopback HTTP URL');
    expect(screen.getByText('Existing keys remain revealable under Clients and Keys')).toBeVisible();
    expect(progress.credential_count).toBe(1);
  });

  it('shows exact settings definitions and clears all session storage on logout', async () => {
    sessionStorage.setItem('unrelated_transient_state', 'remove-me');
    const user = userEvent.setup();
    renderAt('/settings');

    expect(await screen.findByText('0.0.0.0:28772')).toBeVisible();
    expect(screen.getByText('/tmp/gateway.db')).toBeVisible();
    expect(screen.getByText('/tmp/master.key')).toBeVisible();
    expect(screen.getByText('/tmp/admin-secret')).toBeVisible();
    expect(screen.getByText('30 days')).toBeVisible();
    expect(screen.getByText('10 minutes')).toBeVisible();
    expect(screen.getByText('all-interfaces')).toBeVisible();
    expect(screen.getByText('disabled')).toBeVisible();
    await user.click(screen.getAllByRole('button', { name: 'End local session' }).at(-1)!);
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });
});
