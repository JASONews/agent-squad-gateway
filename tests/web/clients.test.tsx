import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { jsonResponse } from '../../web/src/test/fixtures.js';

const fetchMock = vi.fn<typeof fetch>();
const CREATE_SECRET = 'asqsk_created_secret';
const REVEAL_SECRET = 'asqsk_cred_1_secret';
const ROTATE_SECRET = 'asqsk_cred_2_secret';
let revealCalls = 0;
let credentialRevoked = false;
let credentialCreated = false;
let granted = false;
let rotated = false;
let clientDeleted = false;
let clientStatus: 'active' | 'disabled' = 'active';
let credentialExpiresAt: string | null = null;
let extensionEnabled = true;
let consoleCalls: unknown[][] = [];

const client = { id: 'client_1', name: 'Local LiteLLM', status: 'active', createdAt: '2026-07-12T10:00:00.000Z', updatedAt: '2026-07-12T10:00:00.000Z' };
const credential = { id: 'cred_1', clientId: 'client_1', name: 'Local LiteLLM', prefix: 'asqsk_cred_1', createdAt: '2026-07-12T10:00:00.000Z', expiresAt: null, revokedAt: null, lastUsedAt: null, rotatedFrom: null };
const secondaryCredential = { ...credential, id: 'cred_secondary', name: 'Secondary', prefix: 'asqsk_secondary' };
const target = { id: 'codex-main', aliases: ['codex/default'], cli: 'codex', nativeModel: 'gpt-5', reasoningEffort: 'high', enabled: true, isolationLevel: 'strict', streamingMode: 'native', toolBridge: 'structured_output', maxConcurrency: 1, maxQueue: 8, queueTimeoutMs: 300000, runTimeoutMs: null, fixedWorkspace: null, capabilityVersion: '1.0.0', capabilityVerifiedAt: '2026-07-12T10:00:00.000Z', capabilities: {}, capabilityError: null, createdAt: '2026-07-12T10:00:00.000Z', updatedAt: '2026-07-12T10:00:00.000Z' };

function pathOf(input: RequestInfo | URL) { return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url; }

function serialized(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if ((typeof value !== 'object' && typeof value !== 'function') || value === undefined) return String(value);

  const reference = value as object;
  if (seen.has(reference)) return '[Circular]';
  seen.add(reference);

  const entries = Reflect.ownKeys(reference).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(reference, key);
    return `${String(key)}:${descriptor && 'value' in descriptor ? serialized(descriptor.value, seen) : '[accessor]'}`;
  });
  if (value instanceof Error) return [value.name, value.message, value.stack ?? '', ...entries].join('|');
  if (value instanceof Map) return [...value.entries()].map(([key, entry]) => `${serialized(key, seen)}:${serialized(entry, seen)}`).join('|');
  if (value instanceof Set) return [...value].map((entry) => serialized(entry, seen)).join('|');

  let label = '';
  try { label = String(value); } catch { /* Objects without a prototype cannot be stringified. */ }
  return [label, ...entries].join('|');
}

function storageSnapshot(storage: Storage): string {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return key === null ? '' : `${key}:${storage.getItem(key) ?? ''}`;
  }).join('|');
}

function expectSecretAbsent(secret: string): void {
  const queries = queryClient.getQueryCache().findAll().map((query) => ({
    data: query.state.data, error: query.state.error, key: query.queryKey,
  }));
  const mutations = queryClient.getMutationCache().getAll().map((mutation) => ({
    data: mutation.state.data, error: mutation.state.error,
    variables: mutation.state.variables, context: mutation.state.context,
  }));
  const visible = [
    document.body.textContent,
    document.body.innerHTML,
    ...Array.from(document.querySelectorAll<HTMLInputElement>('input')).map((input) => input.value),
  ];
  for (const sink of [
    serialized(queries), serialized(mutations), storageSnapshot(localStorage),
    storageSnapshot(sessionStorage), window.location.href, serialized(window.history.state),
    serialized(visible), serialized(consoleCalls),
  ]) expect(sink).not.toContain(secret);
}

beforeEach(() => {
  revealCalls = 0; credentialRevoked = false; credentialCreated = false; granted = false;
  rotated = false; clientDeleted = false; clientStatus = 'active'; credentialExpiresAt = null;
  extensionEnabled = true; consoleCalls = [];
  fetchMock.mockReset(); queryClient.clear(); localStorage.clear(); sessionStorage.clear();
  for (const method of ['debug', 'error', 'info', 'log', 'warn'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleCalls.push(args); });
  }
  sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
  window.history.replaceState(null, '', '/#/clients/client_1');
  fetchMock.mockImplementation(async (input, init) => {
    const path = pathOf(input); const method = init?.method?.toUpperCase() ?? 'GET';
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/admin/session/csrf') return jsonResponse({ csrf_token: 'csrf', expires_at: '2030-01-01T00:00:00.000Z' });
    if (path === '/admin/clients' && method === 'GET') return jsonResponse({ clients: [] });
    if (path === '/admin/clients/client_1' && method === 'GET') return jsonResponse({ client: { ...client, status: clientStatus }, credentials: [{ ...credential, expiresAt: credentialExpiresAt, revokedAt: credentialRevoked ? '2026-07-12T11:00:00.000Z' : null }, secondaryCredential], grants: granted ? [{ clientId: client.id, extensionId: 'openai', targetId: target.id, createdAt: '2026-07-12T10:00:00.000Z' }] : [] });
    if (path === '/admin/clients/client_1' && method === 'PATCH') {
      clientStatus = (JSON.parse(String(init?.body)) as { status: 'active' | 'disabled' }).status;
      return jsonResponse({ ...client, status: clientStatus });
    }
    if (path === '/admin/clients/client_1' && method === 'DELETE') { clientDeleted = true; return new Response(null, { status: 204 }); }
    if (path === '/admin/clients/client_1/credentials' && method === 'POST') { credentialCreated = true; return jsonResponse({ id: 'cred_created', clientId: client.id, prefix: 'asqsk_created', api_key: CREATE_SECRET }, 201); }
    if (path === '/admin/targets') return jsonResponse({ targets: [target, { ...target, id: 'unverified', enabled: false, capabilityVerifiedAt: null }] });
    if (path === '/admin/extensions') return jsonResponse({ extensions: [{ id: 'openai', version: '1', requiredGatewayVersion: '1', enabled: extensionEnabled, endpoint: '/v1', health: { ok: true } }] });
    if (path === '/admin/credentials/cred_1/reveal') { revealCalls += 1; return jsonResponse({ api_key: REVEAL_SECRET }); }
    if (path === '/admin/credentials/cred_1/revoke' && method === 'POST') { credentialRevoked = true; return new Response(null, { status: 204 }); }
    if (path === '/admin/credentials/cred_1/rotate' && method === 'POST') { rotated = true; credentialRevoked = true; return jsonResponse({ id: 'cred_2', clientId: client.id, prefix: 'asqsk_cred_2', api_key: ROTATE_SECRET }, 201); }
    if (path === '/admin/grants' && method === 'POST') { granted = true; return jsonResponse({}, 201); }
    if (path === '/admin/grants' && method === 'DELETE') { granted = false; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.restoreAllMocks());

describe('Gateway client administration', () => {
  it('deletes a client only after keyboard-accessible confirmation', async () => {
    const user = userEvent.setup();
    render(<GatewayRoot />);
    await user.click(await screen.findByRole('button', { name: 'Delete client' }));
    expect(screen.getByRole('dialog', { name: 'Delete client' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(clientDeleted).toBe(false);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Delete client' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete client' }));
    await user.click(screen.getByRole('button', { name: 'Delete client permanently' }));
    await waitFor(() => expect(clientDeleted).toBe(true));
    await waitFor(() => expect(window.location.hash).toBe('#/clients'));
  });

  it('isolates create, reveal, and rotate plaintext from caches and browser sinks after route change and unmount', async () => {
    const user = userEvent.setup();
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText');
    const view = render(<GatewayRoot />);
    expect(await screen.findByText('asqsk_cred_1_••••••••')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Create credential' }));
    const createDialog = screen.getByRole('dialog', { name: 'Create credential' });
    await user.click(within(createDialog).getByRole('button', { name: 'Create credential' }));
    await waitFor(() => expect(credentialCreated).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create credential' })).not.toBeInTheDocument());
    expectSecretAbsent(CREATE_SECRET);

    await user.click(screen.getByRole('button', { name: 'Reveal key Local LiteLLM' }));
    const secret = await screen.findByDisplayValue(REVEAL_SECRET);
    expect(secret).toHaveAttribute('readonly'); expect(secret).toHaveAttribute('autocomplete', 'off');
    await user.click(screen.getByRole('button', { name: 'Copy key Local LiteLLM' }));
    expect(clipboardWrite).toHaveBeenCalledWith(REVEAL_SECRET);
    await user.click(screen.getByRole('button', { name: 'Hide key Local LiteLLM' }));
    expectSecretAbsent(REVEAL_SECRET);

    await user.click(screen.getByRole('button', { name: 'Rotate key Local LiteLLM' }));
    await user.click(screen.getByRole('button', { name: 'Rotate and revoke' }));
    await waitFor(() => expect(rotated).toBe(true));
    expect(await screen.findByText('Previous key revoked')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate key Local LiteLLM' })).toBeDisabled());
    expectSecretAbsent(ROTATE_SECRET);

    await user.click(screen.getByRole('button', { name: 'Reveal key Local LiteLLM' }));
    expect(await screen.findByDisplayValue(REVEAL_SECRET)).toBeVisible();
    expect(revealCalls).toBe(2);
    await user.click(screen.getAllByRole('link', { name: 'Clients and Keys' })[1]!);
    await screen.findByText('No clients');
    for (const plaintext of [CREATE_SECRET, REVEAL_SECRET, ROTATE_SECRET]) expectSecretAbsent(plaintext);
    view.unmount();
    for (const plaintext of [CREATE_SECRET, REVEAL_SECRET, ROTATE_SECRET]) expectSecretAbsent(plaintext);
  });

  it('detects secrets in direct and nested Error objects written to console sinks', () => {
    console.error(new Error(CREATE_SECRET));
    expect(() => expectSecretAbsent(CREATE_SECRET)).toThrow();
    consoleCalls = [];
    console.error({ nested: [new Error(ROTATE_SECRET)] });
    expect(() => expectSecretAbsent(ROTATE_SECRET)).toThrow();
  });

  it('revokes a credential only after confirmation', async () => {
    const user = userEvent.setup(); render(<GatewayRoot />);
    await user.click(await screen.findByRole('button', { name: 'Revoke key Local LiteLLM' }));
    expect(screen.getByRole('dialog', { name: 'Revoke credential' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Revoke credential' }));
    await waitFor(() => expect(credentialRevoked).toBe(true));
  });

  it('rotates only after keyboard-accessible confirmation and revokes the previous key atomically', async () => {
    const user = userEvent.setup(); render(<GatewayRoot />);
    const rotate = await screen.findByRole('button', { name: 'Rotate key Local LiteLLM' });
    await user.click(rotate);
    expect(screen.getByRole('dialog', { name: 'Rotate credential' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(rotated).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Rotate and revoke' }));
    await waitFor(() => expect(rotated).toBe(true));
    expect(await screen.findByText('Previous key revoked')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Revoke key Secondary' })).toBeEnabled();
    expectSecretAbsent(ROTATE_SECRET);
  });

  it('updates grants and disables unavailable targets with a reason', async () => {
    const user = userEvent.setup();
    for (const key of ['clients', 'credentials', 'grants', 'models-preview']) queryClient.setQueryData([key], { seeded: true });
    render(<GatewayRoot />);
    const available = await screen.findByRole('switch', { name: 'Grant OpenAI to codex-main' });
    const unavailable = screen.getByRole('switch', { name: 'Grant OpenAI to unverified' });
    expect(unavailable).toBeDisabled(); expect(screen.getByText('Target is disabled and unverified')).toBeVisible();
    await user.click(available);
    await waitFor(() => expect(granted).toBe(true));
    await waitFor(() => expect(available).toBeChecked());
    await user.click(available);
    await waitFor(() => expect(granted).toBe(false));
    expect(available).not.toBeChecked();
    for (const key of ['clients', 'credentials', 'grants', 'models-preview']) {
      expect(queryClient.getQueryState([key])?.isInvalidated).toBe(true);
    }
  });

  it('shows why an available target cannot be granted through a disabled extension', async () => {
    extensionEnabled = false;
    render(<GatewayRoot />);
    expect(await screen.findByRole('switch', { name: 'Grant OpenAI to codex-main' })).toBeDisabled();
    expect(screen.getAllByText('Extension is disabled')).toHaveLength(2);
  });

  it('mutates client status separately from credential expiry', async () => {
    const user = userEvent.setup(); render(<GatewayRoot />);
    const toggle = await screen.findByRole('switch', { name: 'Client enabled' });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(clientStatus).toBe('disabled'));
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate key Local LiteLLM' })).toBeEnabled();
  });

  it('shows an expired credential as inactive while the client remains enabled', async () => {
    credentialExpiresAt = '2020-01-01T00:00:00.000Z';
    render(<GatewayRoot />);
    expect(await screen.findByRole('switch', { name: 'Client enabled' })).toBeChecked();
    expect(screen.getByText('Expired')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rotate key Local LiteLLM' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Revoke key Local LiteLLM' })).toBeDisabled();
  });
});
