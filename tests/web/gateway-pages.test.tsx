import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { jsonResponse } from '../../web/src/test/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();
const mutations: Array<{ method: string; path: string }> = [];

const runs = [
  {
    id: 'run_1',
    clientId: 'client-a',
    extensionId: 'openai',
    targetId: 'target-a',
    endpoint: '/v1/responses',
    status: 'queued',
    responseId: 'resp_1',
    nativeSessionId: null,
    errorCode: null,
    queuedAt: '2026-07-12T14:00:00.000Z',
    startedAt: null,
    completedAt: null,
    latencyMs: null,
  },
  {
    id: 'run_2',
    clientId: 'client-b',
    extensionId: 'openai',
    targetId: 'target-b',
    endpoint: '/v1/chat/completions',
    status: 'running',
    responseId: null,
    nativeSessionId: 'native_2',
    errorCode: null,
    queuedAt: '2026-07-12T13:00:00.000Z',
    startedAt: '2026-07-12T13:00:01.000Z',
    completedAt: null,
    latencyMs: null,
  },
  {
    id: 'run_3',
    clientId: null,
    extensionId: 'openai',
    targetId: 'target-a',
    endpoint: '/v1/responses',
    status: 'failed',
    responseId: 'resp_3',
    nativeSessionId: null,
    errorCode: 'provider_failed',
    queuedAt: '2026-07-11T10:00:00.000Z',
    startedAt: '2026-07-11T10:00:01.000Z',
    completedAt: '2026-07-11T10:00:02.250Z',
    latencyMs: 1250,
  },
];

const latestRuns = Array.from({ length: 21 }, (_, index) => ({
  ...runs[2],
  id: `latest_${String(index).padStart(2, '0')}`,
  targetId: `latest-target-${String(index).padStart(2, '0')}`,
  queuedAt: new Date(Date.UTC(2026, 6, 12, 18, 0, 0) - index * 1_000).toISOString(),
}));

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function installApi(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = requestPath(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/admin/session/csrf') {
      return jsonResponse({ csrf_token: 'csrf_rotated', expires_at: '2026-07-13T12:00:00.000Z' });
    }
    if (path === '/health') {
      return jsonResponse({ ok: true, version: '0.1.0', db_ok: true });
    }
    if (path === '/admin/core/health') {
      return jsonResponse({ ok: false, version: '0.9.0', connection: { status: 'degraded' } });
    }
    if (path.startsWith('/admin/runs') && method === 'GET') {
      const url = new URL(path, 'http://gateway.local');
      const filteredRuns = runs.filter((run) =>
        (!url.searchParams.get('status') || run.status === url.searchParams.get('status'))
        && (!url.searchParams.get('target_id') || run.targetId === url.searchParams.get('target_id'))
        && (!url.searchParams.get('client_id') || run.clientId === url.searchParams.get('client_id')),
      );
      return jsonResponse({
        runs: path === '/admin/runs/overview' ? latestRuns.slice(0, 20) : filteredRuns,
        verifiedTargetCount: 2,
        activeRunCount: 7,
        queuePressure: [{ targetId: 'target-older-active', queued: 4, running: 3 }],
      });
    }
    if (path === '/admin/runs/run_1/cancel' && method === 'POST') {
      mutations.push({ method, path });
      return jsonResponse({ cancelled: true, id: 'run_1' });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
}

function renderAt(path: string): void {
  window.location.hash = `#${path}`;
  render(<GatewayRoot />);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-12T15:00:00.000Z'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  queryClient.clear();
  mutations.length = 0;
  sessionStorage.clear();
  sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  installApi();
});

afterEach(() => vi.restoreAllMocks());

describe('Gateway operations pages', () => {
  it('shows exact operational navigation and a mobile drawer control', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 759 });
    const user = userEvent.setup();
    renderAt('/runs');

    const navigation = await screen.findByRole('navigation', { name: 'Gateway' });
    expect(within(navigation).getAllByRole('link').map((link) => link.textContent?.trim())).toEqual([
      'Overview',
      'API Runs',
      'Invocation Targets',
      'Clients and Keys',
      'Extensions',
      'Core Sessions',
      'Pending Core Choices',
      'CLI Availability',
      'Settings',
    ]);
    expect(within(navigation).getByRole('link', { name: 'API Runs' })).toHaveAttribute('aria-current', 'page');

    const menu = screen.getByRole('button', { name: 'Open navigation' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(navigation).toHaveAttribute('inert');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const close = screen.getByRole('button', { name: 'Close navigation' });
    expect(close).toHaveFocus();
    expect(document.querySelector('.workspace')).toHaveAttribute('inert');
    await user.tab({ shift: true });
    expect(within(navigation).getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(navigation).toHaveAttribute('inert');
    expect(document.querySelector('.workspace')).not.toHaveAttribute('inert');
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(screen.getByRole('button', { name: 'Dismiss navigation' }));
    expect(document.querySelector('.workspace')).not.toHaveAttribute('inert');
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(document.querySelector('.workspace')).not.toHaveAttribute('inert');
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(within(navigation).getByRole('link', { name: 'Overview' }));
    await screen.findByRole('heading', { name: 'Overview' });
    expect(document.querySelector('.workspace')).not.toHaveAttribute('inert');
    expect(menu).toHaveFocus();
  });

  it('renders the overview status band, queue pressure, and latest Runs table', async () => {
    renderAt('/overview');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible();
    const status = screen.getByRole('region', { name: 'Operations status' });
    for (const label of ['Gateway', 'Core', 'Active Runs', 'Verified Targets']) {
      expect(within(status).getByText(label)).toBeVisible();
    }
    const verifiedTargets = within(status).getByText('Verified Targets').closest('.metric-cell');
    expect(verifiedTargets).not.toBeNull();
    expect(await within(verifiedTargets!).findByText('2')).toBeVisible();
    const activeRuns = within(status).getByText('Active Runs').closest('.metric-cell');
    expect(await within(activeRuns!).findByText('7')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Queue pressure' })).toBeVisible();
    const pressure = screen.getByRole('region', { name: 'Queue pressure' });
    expect(await within(pressure).findByText('target-older-active')).toBeVisible();
    expect(within(pressure).getByText('4 queued')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Recent API Runs' })).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Target' })).toBeVisible();
    const table = screen.getByRole('table', { name: 'API Runs' });
    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(within(table).getByText('latest-target-00')).toBeVisible();
    expect(within(table).queryByText('latest-target-20')).not.toBeInTheDocument();
  });

  it('filters Runs and cancels only a Gateway-owned API run after confirmation', async () => {
    const user = userEvent.setup();
    renderAt('/runs');

    expect(await screen.findByRole('columnheader', { name: 'Target' })).toBeVisible();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Started', 'Client', 'Extension', 'Endpoint', 'Target', 'Status', 'Latency', 'Error', 'Actions',
    ]);

    await user.selectOptions(screen.getByLabelText('Status'), 'running');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel run run_2' })).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Cancel run run_1' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Target'), 'target-b');
    await user.selectOptions(screen.getByLabelText('Client'), 'client-b');
    await user.selectOptions(screen.getByLabelText('Time range'), '1h');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/admin/runs?limit=100&status=running&target_id=target-b&client_id=client-b',
      expect.objectContaining({ credentials: 'same-origin' }),
    ));

    await user.selectOptions(screen.getByLabelText('Status'), '');
    await user.selectOptions(screen.getByLabelText('Target'), '');
    await user.selectOptions(screen.getByLabelText('Client'), '');
    await user.selectOptions(screen.getByLabelText('Time range'), '1h');
    expect(screen.getByText('1 runs')).toBeVisible();
    expect(screen.queryByText('provider_failed')).not.toBeInTheDocument();
    const initialRunReads = fetchMock.mock.calls.filter(([input, init]) =>
      requestPath(input).startsWith('/admin/runs') && (init?.method ?? 'GET') === 'GET').length;

    const cancelTrigger = screen.getByRole('button', { name: 'Cancel run run_1' });
    await user.click(cancelTrigger);
    expect(screen.getByRole('dialog', { name: 'Cancel API run' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep running' })).toHaveFocus();
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Confirm cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Cancel API run' })).not.toBeInTheDocument();
    expect(document.querySelector('.app-shell')).not.toHaveAttribute('inert');
    expect(cancelTrigger).toHaveFocus();
    await user.click(cancelTrigger);
    await user.click(screen.getByRole('button', { name: 'Confirm cancel' }));

    await waitFor(() => expect(mutations).toEqual([
      { method: 'POST', path: '/admin/runs/run_1/cancel' },
    ]));
    await waitFor(() => {
      const runReads = fetchMock.mock.calls.filter(([input, init]) =>
        requestPath(input).startsWith('/admin/runs') && (init?.method ?? 'GET') === 'GET').length;
      expect(runReads).toBeGreaterThan(initialRunReads);
    });
    expect(screen.queryByRole('button', { name: /Core.*cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel run run_3' })).not.toBeInTheDocument();
  });
});
