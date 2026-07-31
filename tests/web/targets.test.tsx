import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { jsonResponse } from '../../web/src/test/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();
const mutations: Array<{ method: string; path: string; body: unknown }> = [];
let verificationResponse: Promise<Response> | null = null;

const target = {
  id: 'codex-gpt56-max',
  aliases: ['codex/gpt-5.6/max'],
  cli: 'codex',
  nativeModel: 'gpt-5.6',
  reasoningEffort: 'max',
  enabled: false,
  isolationLevel: 'best_effort',
  streamingMode: 'native',
  toolBridge: 'structured_output',
  maxConcurrency: 1,
  maxQueue: 8,
  queueTimeoutMs: 300000,
  runTimeoutMs: null,
  fixedWorkspace: null,
  capabilityVersion: '1.2.0',
  capabilityVerifiedAt: '2026-07-12T12:00:00.000Z',
  capabilities: {
    isolationLevel: 'best_effort',
    streamingMode: 'native',
    toolBridge: 'structured_output',
    resume: true,
    cancellation: true,
    modelSelection: true,
    effortSelection: true,
  },
  capabilityError: null,
  createdAt: '2026-07-12T11:00:00.000Z',
  updatedAt: '2026-07-12T12:00:00.000Z',
};

const antigravityTarget = {
  ...target,
  id: 'antigravity-gemini-pro',
  aliases: [],
  cli: 'antigravity',
  nativeModel: 'gemini-3.5-pro',
  reasoningEffort: null,
  streamingMode: 'native',
  toolBridge: 'structured_output',
  capabilityVersion: '0.4.0',
  capabilities: {
    ...target.capabilities,
    streamingMode: 'none',
    toolBridge: 'none',
    effortSelection: false,
  },
};

const unverifiedAntigravityTarget = {
  ...antigravityTarget,
  id: 'antigravity-gemini-flash-high',
  nativeModel: 'Gemini 3.5 Flash (High)',
  streamingMode: 'none',
  capabilityVerifiedAt: null,
  capabilities: null,
  capabilityError: 'conformance_required',
};

function pathOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function installApi(): void {
  fetchMock.mockImplementation(async (input, init) => {
    const path = pathOf(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/admin/session/csrf') {
      return jsonResponse({ csrf_token: 'csrf_rotated', expires_at: '2026-07-13T12:00:00.000Z' });
    }
    if (path === '/admin/targets' && method === 'GET') {
      return jsonResponse({ targets: [target, antigravityTarget, unverifiedAntigravityTarget] });
    }
    if (path === '/admin/targets' && method === 'POST') {
      mutations.push({ method, path, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ ...target, id: 'codex-gpt57-high', nativeModel: 'gpt-5.7', reasoningEffort: 'high' }, 201);
    }
    if (path === '/admin/targets/codex-gpt56-max' && method === 'PATCH') {
      mutations.push({ method, path, body: JSON.parse(String(init?.body)) });
      return jsonResponse(target);
    }
    if (path === '/admin/targets/codex-gpt56-max/verify' && method === 'POST') {
      mutations.push({ method, path, body: JSON.parse(String(init?.body)) });
      return verificationResponse
        ?? jsonResponse({ capabilities: target.capabilities, model_usage_consumed: true });
    }
    if (path === '/admin/targets/codex-gpt56-max' && method === 'DELETE') {
      mutations.push({ method, path, body: null });
      return new Response(null, { status: 204 });
    }
    if (path === '/admin/cli-availability' && method === 'GET') {
      return jsonResponse({ cli_availability: availability });
    }
    if (path === '/admin/cli-availability/refresh' && method === 'POST') {
      mutations.push({ method, path, body: JSON.parse(String(init?.body ?? '{}')) });
      return jsonResponse({ cli_availability: availability });
    }
    if (path === '/admin/extensions' && method === 'GET') {
      return jsonResponse({ extensions: [{ id: 'openai', version: '1.0.0', requiredGatewayVersion: '0.1.0', enabled: true, endpoint: '/v1', health: { ok: true } }] });
    }
    if (path === '/admin/extensions/openai' && method === 'PATCH') {
      mutations.push({ method, path, body: JSON.parse(String(init?.body)) });
      return jsonResponse({ enabled: false });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
}

const availability = ['codex', 'claude', 'cursor', 'opencode', 'antigravity'].map((cli, index) => ({
  cli,
  scannedAt: '2026-07-12T12:30:00.000Z',
  verificationCount: index === 0 ? 1 : 0,
  capabilities: {
    available: true,
    version: `1.${index}.0`,
    verified: false,
    modelSelection: true,
    effortSelection: cli !== 'antigravity' && cli !== 'cursor',
    isolationLevel: 'best_effort',
    streamingMode: cli === 'antigravity' ? 'none' : 'native',
    toolBridge: cli === 'antigravity' ? 'none' : 'structured_output',
    resume: cli !== 'antigravity',
    cancellation: true,
    modelOptions: cli === 'codex' ? [
      {
        id: 'gpt-5.6',
        label: 'GPT-5.6',
        effortOptions: ['low', 'high', 'max'],
        profile: {
          source: 'official_default' as const,
          summary: 'Routine implementation profile.',
          strengths: ['Fast implementation'],
          weaknesses: ['Not for high-risk review'],
          recommendedFor: ['basic_implementation'],
          avoidFor: ['security_review'],
          costTier: 'low' as const,
          latencyTier: 'fast' as const,
          priority: 90,
          effortProfiles: {
            max: {
              summary: 'Careful routine implementation profile.',
              priority: 92,
            },
          },
        },
      },
      { id: 'gpt-5.7', label: 'GPT-5.7', effortOptions: ['low', 'high'] },
    ] : cli === 'claude' ? [
      { id: 'default', label: 'Default (Opus)', effortOptions: ['low', 'high', 'max'] },
    ] : cli === 'cursor' ? [
      { id: 'gpt-5.6-sol-max', label: 'GPT-5.6 Sol 1M Max', effortOptions: null },
    ] : cli === 'opencode' ? [
      { id: 'openai/gpt-5.6', label: 'openai/gpt-5.6', effortOptions: null },
    ] : [
      { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)', effortOptions: null },
    ],
  },
}));

function renderAt(path: string): void {
  window.location.hash = `#${path}`;
  render(<GatewayRoot />);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  queryClient.clear();
  mutations.length = 0;
  sessionStorage.clear();
  sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
  window.history.replaceState(null, '', '/');
  availability[0]!.capabilities.version = '1.2.0';
  verificationResponse = null;
  installApi();
});

describe('Gateway target administration', () => {
  it('requires explicit quota confirmation before verifying a target', async () => {
    const user = userEvent.setup();
    renderAt('/targets');

    const trigger = await screen.findByRole('button', { name: 'Verify codex-gpt56-max' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Verify target' })).toBeVisible();
    expect(screen.getByText(/This runs bounded model requests and may consume quota/)).toBeVisible();
    expect(screen.getByText(/Verification applies to this target's model and execution settings/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(document.querySelector('.app-shell')).toHaveAttribute('inert');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Verify target' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Verify target' }));
    await waitFor(() => expect(mutations).toEqual([{
      method: 'POST',
      path: '/admin/targets/codex-gpt56-max/verify',
      body: { confirm_model_usage: true },
    }]));
  });

  it('edits exact target fields with explicit isolation acknowledgements', async () => {
    const user = userEvent.setup();
    renderAt('/targets');

    await user.click(await screen.findByRole('button', { name: 'Edit codex-gpt56-max' }));
    expect(screen.getByRole('dialog', { name: 'Edit target' })).toBeVisible();
    expect(screen.getByLabelText('Canonical ID')).toHaveValue('codex-gpt56-max');
    expect(screen.getByLabelText('Aliases')).toHaveValue('codex/gpt-5.6/max');
    expect(screen.getByLabelText('Native model')).toHaveValue('gpt-5.6');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('max');
    expect(screen.getByLabelText('Max concurrency')).toHaveValue('1');
    expect(screen.getByLabelText('Max queue')).toHaveValue('8');
    expect(screen.getByLabelText('Run timeout')).toHaveValue('');
    expect(screen.getByRole('region', { name: 'Model profile' })).toHaveTextContent(
      'Careful routine implementation profile.',
    );
    expect(screen.getByRole('region', { name: 'Model profile' })).toHaveTextContent(
      'Fast implementation',
    );
    expect(screen.getByRole('region', { name: 'Model profile' })).toHaveTextContent(
      'Priority: 92',
    );

    await user.selectOptions(screen.getByLabelText('Workspace'), 'fixed');
    await user.type(screen.getByLabelText('Fixed workspace path'), '/Users/me/project');
    const downgrade = screen.getByRole('switch', { name: 'Acknowledge workspace isolation downgrade' });
    expect(downgrade).toHaveAttribute('aria-required', 'true');
    expect(screen.getByLabelText('Isolation')).toHaveValue('best_effort');
    await user.click(downgrade);
    await user.selectOptions(screen.getByLabelText('Max concurrency'), '2');
    await user.selectOptions(screen.getByLabelText('Max queue'), within(screen.getByLabelText('Max queue')).getByRole('option', { name: 'Custom...' }));
    await user.type(screen.getByLabelText('Custom max queue'), '12');
    await user.click(screen.getByRole('button', { name: 'Save target' }));

    await waitFor(() => expect(mutations).toContainEqual({
      method: 'PATCH',
      path: '/admin/targets/codex-gpt56-max',
      body: {
        aliases: ['codex/gpt-5.6/max'],
        cli: 'codex',
        native_model: 'gpt-5.6',
        reasoning_effort: 'max',
        enabled: false,
        isolation_level: 'best_effort',
        streaming_mode: 'native',
        tool_bridge: 'structured_output',
        max_concurrency: 2,
        max_queue: 12,
        queue_timeout_ms: 300000,
        run_timeout_ms: null,
        fixed_workspace: '/Users/me/project',
        acknowledge_fixed_workspace_downgrade: true,
      },
    }));
  });

  it('does not keep a stale profile after selecting a custom model', async () => {
    const user = userEvent.setup();
    renderAt('/targets');

    await user.click(await screen.findByRole('button', { name: 'Edit codex-gpt56-max' }));
    expect(screen.getByRole('region', { name: 'Model profile' })).toBeVisible();

    await user.selectOptions(
      screen.getByLabelText('Native model'),
      within(screen.getByLabelText('Native model')).getByRole('option', { name: 'Custom...' }),
    );
    expect(screen.queryByRole('region', { name: 'Model profile' })).not.toBeInTheDocument();
  });

  it('shows verification progress in the dialog and target row until completion', async () => {
    let finishVerification: (response: Response) => void = () => {};
    verificationResponse = new Promise<Response>((resolve) => { finishVerification = resolve; });
    const user = userEvent.setup();
    renderAt('/targets');

    await user.click(await screen.findByRole('button', { name: 'Verify codex-gpt56-max' }));
    const dialog = screen.getByRole('dialog', { name: 'Verify target' });
    await user.click(within(dialog).getByRole('button', { name: 'Verify target' }));

    expect(await within(dialog).findByRole('status')).toHaveTextContent('Verification in progress');
    expect(within(dialog).getByRole('button', { name: 'Verifying...' }))
      .toHaveAttribute('aria-busy', 'true');
    expect(dialog.querySelectorAll('.icon-spin')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Hide' }));

    expect(screen.queryByRole('dialog', { name: 'Verify target' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Verifying target codex-gpt56-max');
    expect(screen.getByRole('button', { name: 'Verifying codex-gpt56-max' }))
      .toHaveAttribute('aria-busy', 'true');

    finishVerification(jsonResponse({ capabilities: target.capabilities, model_usage_consumed: true }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Verify codex-gpt56-max' })).toBeEnabled();
  });

  it('shows unsupported capabilities and guards enablement without silent downgrade', async () => {
    renderAt('/targets');

    const table = await screen.findByRole('table', { name: 'Invocation Targets' });
    expect(await screen.findByText('antigravity-gemini-pro')).toBeVisible();
    expect(screen.getAllByText('Unsupported')).toHaveLength(2);
    expect(screen.getByRole('switch', { name: 'Enable antigravity-gemini-pro' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enable codex-gpt56-max' })).toBeEnabled();
    expect(table).toHaveTextContent('1/8');
  });

  it('presents conformance-required targets as one clear verification state', async () => {
    renderAt('/targets');

    const id = await screen.findByText('antigravity-gemini-flash-high');
    const row = id.closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getAllByText('Unverified')).toHaveLength(2);
    expect(within(row!).getByText('Verification required')).toHaveAttribute(
      'title',
      'conformance_required',
    );
    expect(row).not.toHaveTextContent('conformance_required');
  });

  it('shows static and verified versions and blocks a stale version', async () => {
    availability[0]!.capabilities.version = '2.0.0';
    renderAt('/targets');

    const table = await screen.findByRole('table', { name: 'Invocation Targets' });
    await waitFor(() => expect(table).toHaveTextContent('2.0.0 / 1.2.0'));
    expect(table).toHaveTextContent('Version mismatch');
    expect(screen.getByRole('switch', { name: 'Enable codex-gpt56-max' })).toBeDisabled();
  });

  it('rejects whitespace fixed workspace in the editor', async () => {
    const user = userEvent.setup();
    renderAt('/targets');
    await user.click(await screen.findByRole('button', { name: 'Edit codex-gpt56-max' }));

    await user.selectOptions(screen.getByLabelText('Workspace'), 'fixed');
    await user.type(screen.getByLabelText('Fixed workspace path'), '   ');
    await user.click(screen.getByRole('button', { name: 'Save target' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an absolute fixed workspace path.');
    expect(mutations.some((entry) => entry.method === 'PATCH')).toBe(false);
  });

  it('rejects decimal timeouts and accepts a blank nullable run timeout independently', async () => {
    const user = userEvent.setup();
    renderAt('/targets');
    await user.click(await screen.findByRole('button', { name: 'Edit codex-gpt56-max' }));

    const save = screen.getByRole('button', { name: 'Save target' });
    const queueTimeout = screen.getByLabelText('Queue timeout');
    const runTimeout = screen.getByLabelText('Run timeout');
    expect(screen.getByLabelText('Workspace')).toHaveValue('managed');

    await user.selectOptions(queueTimeout, within(queueTimeout).getByRole('option', { name: 'Custom...' }));
    await user.type(screen.getByLabelText('Custom queue timeout'), '1.5');
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent('Queue timeout must be a positive whole number of milliseconds.');

    await user.clear(screen.getByLabelText('Custom queue timeout'));
    await user.type(screen.getByLabelText('Custom queue timeout'), '100');

    await user.selectOptions(runTimeout, within(runTimeout).getByRole('option', { name: 'Custom...' }));
    await user.type(screen.getByLabelText('Custom run timeout'), '2.5');
    await user.click(save);
    expect(screen.getByRole('alert')).toHaveTextContent('Run timeout must be blank or a positive whole number of milliseconds.');

    await user.selectOptions(runTimeout, '');
    await user.click(save);
    await waitFor(() => expect(mutations).toContainEqual(expect.objectContaining({
      method: 'PATCH',
      path: '/admin/targets/codex-gpt56-max',
      body: expect.objectContaining({ queue_timeout_ms: 100, run_timeout_ms: null }),
    })));
  });

  it('requires a best-effort acknowledgement before enabling a compatible target', async () => {
    const user = userEvent.setup();
    renderAt('/targets');
    await user.click(await screen.findByRole('switch', { name: 'Enable codex-gpt56-max' }));
    expect(screen.getByRole('dialog', { name: 'Enable target' })).toBeVisible();
    const acknowledgement = screen.getByRole('switch', { name: 'Allow best-effort isolation' });
    expect(acknowledgement).toHaveAttribute('aria-required', 'true');
    expect(screen.getByRole('button', { name: 'Enable target' })).toBeDisabled();
    expect(mutations.some((entry) => entry.path === '/admin/targets/codex-gpt56-max' && entry.body !== null && (entry.body as { enabled?: boolean }).enabled)).toBe(false);
    await user.click(acknowledgement);
    await user.click(screen.getByRole('button', { name: 'Enable target' }));
    await waitFor(() => expect(mutations).toContainEqual({
      method: 'PATCH',
      path: '/admin/targets/codex-gpt56-max',
      body: { enabled: true, enabled_best_effort: true },
    }));
  });

  it('proposes a canonical ID, validates aliases, creates, and deletes targets', async () => {
    const user = userEvent.setup();
    renderAt('/targets');
    await user.click(await screen.findByRole('button', { name: 'Create target' }));
    expect(screen.getByLabelText('Native model')).toHaveValue('gpt-5.6');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('max');
    expect(screen.getByLabelText('Canonical ID')).toHaveValue('codex-gpt56-max');

    await user.selectOptions(screen.getByLabelText('Native model'), 'gpt-5.7');
    expect(screen.getByLabelText('Canonical ID')).toHaveValue('codex-gpt57-high');
    await user.type(screen.getByLabelText('Aliases'), 'codex-gpt57-high');
    await user.click(screen.getByRole('button', { name: 'Create and verify' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Aliases must be unique and different from the canonical ID.');
    expect(mutations.some((entry) => entry.method === 'POST' && entry.path === '/admin/targets')).toBe(false);
    await user.clear(screen.getByLabelText('Aliases'));
    await user.click(screen.getByRole('button', { name: 'Create and verify' }));
    await waitFor(() => expect(mutations).toContainEqual(expect.objectContaining({
      method: 'POST', path: '/admin/targets', body: expect.objectContaining({
        id: 'codex-gpt57-high', verify_on_create: true, confirm_model_usage: true,
      }),
    })));

    const deleteButton = await screen.findByRole('button', { name: 'Delete codex-gpt56-max' });
    await user.click(deleteButton);
    expect(screen.getByRole('dialog', { name: 'Delete target' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete target' }));
    await waitFor(() => expect(mutations).toContainEqual({
      method: 'DELETE', path: '/admin/targets/codex-gpt56-max', body: null,
    }));
  });

  it('supports custom model and reasoning choices when the scan does not list them', async () => {
    const user = userEvent.setup();
    renderAt('/targets');
    await user.click(await screen.findByRole('button', { name: 'Create target' }));

    const model = screen.getByLabelText('Native model');
    await user.selectOptions(model, within(model).getByRole('option', { name: 'Custom...' }));
    expect(screen.getByRole('status')).toHaveTextContent('Select a native model or enter a custom model.');
    await user.type(screen.getByLabelText('Custom native model'), 'gpt-private');

    const effort = screen.getByLabelText('Reasoning effort');
    await user.selectOptions(effort, within(effort).getByRole('option', { name: 'Custom...' }));
    await user.type(screen.getByLabelText('Custom reasoning effort'), 'ultra');
    expect(screen.getByLabelText('Canonical ID')).toHaveValue('codex-gptprivate-ultra');
    await user.click(screen.getByRole('button', { name: 'Create and verify' }));

    await waitFor(() => expect(mutations).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/admin/targets',
      body: expect.objectContaining({
        id: 'codex-gptprivate-ultra',
        native_model: 'gpt-private',
        reasoning_effort: 'ultra',
        verify_on_create: true,
        confirm_model_usage: true,
      }),
    })));
  });

  it('refreshes static CLI ceilings without model confirmation', async () => {
    const user = userEvent.setup();
    renderAt('/cli-availability');
    for (const name of ['Codex', 'Claude Code', 'Cursor Agent', 'OpenCode', 'Antigravity']) {
      expect(await screen.findByText(name)).toBeVisible();
    }
    expect(screen.getByText('1 verified')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh CLI availability' }));
    await waitFor(() => expect(mutations).toContainEqual({
      method: 'POST', path: '/admin/cli-availability/refresh', body: {},
    }));
    expect(screen.queryByText(/consume quota/i)).not.toBeInTheDocument();
  });

  it('toggles compiled extensions without duplicating model or key management', async () => {
    const user = userEvent.setup();
    renderAt('/extensions');
    expect(await screen.findByRole('heading', { name: 'Extensions' })).toBeVisible();
    expect(await screen.findByText('OpenAI')).toBeVisible();
    expect(screen.getByText('/v1')).toBeVisible();
    await user.click(screen.getByRole('switch', { name: 'Enable OpenAI' }));
    await waitFor(() => expect(mutations).toContainEqual({
      method: 'PATCH', path: '/admin/extensions/openai', body: { enabled: false },
    }));
    expect(screen.queryByText(/API key|model management/i)).not.toBeInTheDocument();
  });
});
