import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRoot } from '../../web/src/app/router.js';
import { queryClient } from '../../web/src/app/query-client.js';
import { gatewayErrorResponse, jsonResponse } from '../../web/src/test/fixtures.js';
import type { CoreChoice, CoreDebugBundle, CoreSession } from '../../web/src/api/types.js';

const NOW = '2026-07-12T15:00:00.000Z';
const LAST_SEEN = '2026-07-12T14:58:00.000Z';
const fetchMock = vi.fn<typeof fetch>();

const session = {
  id: 'sess_1',
  root_task: 'Review payment retry logic',
  repo_path: '/work/payment-service',
  main_peer_id: 'main_1',
  created_at: '2026-07-12T14:30:00.000Z',
  updated_at: '2026-07-12T14:59:00.000Z',
};

const debugBundle = {
  session,
  subagents: [{
    id: 'sub_1',
    alias: 'rev',
    cli_type: 'codex',
    role: 'reviewer',
    status: 'running',
    native_session_id: 'native_rev_1',
    cwd: '/work/payment-service',
    model: 'gpt-5',
    reasoning_effort: 'high',
    last_seen_at: LAST_SEEN,
    raw_tail: 'checking item_74\n<script>alert("no")</script>',
  }],
  messages: [{
    id: 'msg_1',
    session_id: 'sess_1',
    from_peer_id: 'sub_1',
    to_peer_id: 'main_1',
    kind: 'status',
    content: 'Retry branch is reachable.',
    artifact_refs: null,
    created_at: '2026-07-12T14:57:00.000Z',
  }],
  choices: [],
};

function choiceFixtures(): CoreChoice[] {
  return [
    {
      id: 'choice_db', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
      question: 'Choose database',
      options: [{ id: 'pg', label: 'Postgres', tradeoff: 'Operationally familiar.' }, { id: 'sqlite', label: 'SQLite' }],
      recommendation: { option_id: 'pg', reason: 'Matches production operations.', confidence: 'high' },
      status: 'pending_main_agent', selected: null, rationale: null,
      created_at: '2026-07-12T14:55:00.000Z', resolved_at: null,
    },
    {
      id: 'choice_cache', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
      question: 'Choose cache',
      options: [{ id: 'redis', label: 'Redis', tradeoff: 'Shared service to operate.' }, { id: 'memory', label: 'In-memory', tradeoff: 'No cross-process sharing.' }],
      recommendation: null, status: 'pending_main_agent', selected: null, rationale: null,
      created_at: '2026-07-12T14:56:00.000Z', resolved_at: null,
    },
    {
      id: 'choice_region', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
      question: 'Choose region', options: [{ id: 'east', label: 'US East' }], recommendation: null,
      status: 'pending_main_agent', selected: null, rationale: null,
      created_at: '2026-07-12T14:57:00.000Z', resolved_at: null,
    },
  ];
}
let debugResponse: CoreDebugBundle = structuredClone(debugBundle);
let sessionListResponse: CoreSession[] = [session];
let debugById = new Map<string, CoreDebugBundle>();
let activeDebugReads = 0;
let maxConcurrentDebugReads = 0;
let sessionFailures = 0;
let pendingChoices: CoreChoice[] = [];
let mutations: Array<{ path: string; method: string; body: unknown }> = [];
let choiceFailures = 0;
let choiceReadCount = 0;
let resolveConflict = false;
let resolveGate: Promise<void> | null = null;
let viewport: ReturnType<typeof installViewport>;

function installViewport(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener);
  });
  const removeEventListener = vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener);
  });
  const mediaQuery = {
    get matches() { return matches; },
    media: '(max-width: 959px)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));
  return {
    addEventListener,
    removeEventListener,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      act(() => listeners.forEach((listener) => listener(event)));
    },
  };
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(url: string | URL, init?: EventSourceInit) {
    this.url = String(url);
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  emitMessage(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }));
  }

  emitError(readyState = FakeEventSource.CONNECTING): void {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

function installApi(): void {
  fetchMock.mockImplementation(async (input, init = {}) => {
    const path = requestPath(input);
    if (path === '/admin/auth/mode') return jsonResponse({ mode: 'token' });
    if (path === '/admin/session/csrf') {
      return jsonResponse({ csrf_token: 'csrf_rotated', expires_at: '2026-07-13T12:00:00.000Z' });
    }
    if (path === '/admin/core/sessions') {
      if (sessionFailures > 0) {
        sessionFailures -= 1;
        throw new TypeError('Core offline');
      }
      return jsonResponse({ sessions: sessionListResponse });
    }
    if (path === '/admin/core/choices?status=pending') {
      choiceReadCount += 1;
      if (choiceFailures > 0) {
        choiceFailures -= 1;
        throw new TypeError('Core offline');
      }
      return jsonResponse({ choices: pendingChoices });
    }
    const resolveMatch = /^\/admin\/core\/sessions\/([^/]+)\/choices\/([^/]+)\/resolve$/.exec(path);
    if (resolveMatch?.[1] && resolveMatch[2] && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { selected: string; rationale?: string };
      mutations.push({ path, method: init.method, body });
      if (resolveGate) await resolveGate;
      if (resolveConflict) {
        pendingChoices = pendingChoices.filter((choice) => choice.id !== decodeURIComponent(resolveMatch[2]!));
        return gatewayErrorResponse(409, 'core_choice_not_pending', 'Choice is no longer pending');
      }
      pendingChoices = pendingChoices.filter((choice) => choice.id !== decodeURIComponent(resolveMatch[2]!));
      return new Response(null, { status: 204 });
    }
    const debugMatch = /^\/admin\/core\/sessions\/([^/]+)\/debug$/.exec(path);
    if (debugMatch?.[1]) {
      activeDebugReads += 1;
      maxConcurrentDebugReads = Math.max(maxConcurrentDebugReads, activeDebugReads);
      await Promise.resolve();
      activeDebugReads -= 1;
      return jsonResponse(debugById.get(decodeURIComponent(debugMatch[1])) ?? debugResponse);
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

function renderAt(path: string) {
  window.location.hash = `#${path}`;
  return render(<GatewayRoot />);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
  viewport = installViewport(false);
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  queryClient.clear();
  sessionStorage.clear();
  sessionStorage.setItem('asq_gateway_csrf', 'csrf_previous');
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  debugResponse = structuredClone(debugBundle);
  sessionListResponse = [session];
  debugById = new Map();
  activeDebugReads = 0;
  maxConcurrentDebugReads = 0;
  sessionFailures = 0;
  pendingChoices = [];
  mutations = [];
  choiceFailures = 0;
  choiceReadCount = 0;
  resolveConflict = false;
  resolveGate = null;
  FakeEventSource.instances = [];
  installApi();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Core session debugger', () => {
  it('shows full live debug history without collaboration controls', async () => {
    const user = userEvent.setup();
    renderAt('/core/sessions/sess_1');

    expect(await screen.findByText('Review payment retry logic')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Messages' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Subagents' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByText('rev')).toBeVisible();
    expect(screen.getByText('2 minutes ago')).toHaveAttribute('title', LAST_SEEN);

    await user.click(screen.getByRole('button', { name: 'View raw tail for rev' }));
    expect(screen.getByRole('dialog', { name: 'Raw tail: rev' })).toBeVisible();
    expect(screen.getByText(/item_74/)).toBeVisible();
    expect(document.querySelector('.raw-tail__content script')).toBeNull();
    expect(screen.queryByRole('button', { name: /kill|terminate|send|spawn/i })).not.toBeInTheDocument();
  });

  it('limits messages to the newest history and renders them chronologically', async () => {
    debugResponse.messages = Array.from({ length: 501 }, (_, index) => ({
      id: `msg_${index}`,
      session_id: 'sess_1',
      from_peer_id: 'sub_1',
      to_peer_id: 'main_1',
      kind: 'status',
      content: `history-${index}`,
      artifact_refs: null,
      created_at: new Date(Date.parse('2026-07-12T12:00:00.000Z') + index * 1_000).toISOString(),
    })).reverse();

    renderAt('/core/sessions/sess_1');

    expect(await screen.findByText('history-500')).toBeVisible();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.core-message'));
    expect(rows).toHaveLength(500);
    expect(rows[0]).toHaveAttribute('data-message-id', 'msg_1');
    expect(rows.at(-1)).toHaveAttribute('data-message-id', 'msg_500');
    expect(screen.queryByText('history-0')).not.toBeInTheDocument();
  });

  it('copies the native session ID and presents a null raw-tail state', async () => {
    debugResponse.subagents[0]!.raw_tail = null;
    const user = userEvent.setup();
    renderAt('/core/sessions/sess_1');

    await screen.findByText('Review payment retry logic');
    await user.click(screen.getByRole('button', { name: 'Copy native session ID for rev' }));
    expect(await navigator.clipboard.readText()).toBe('native_rev_1');

    await user.click(screen.getByRole('button', { name: 'View raw tail for rev' }));
    expect(screen.getByText('No raw tail available.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy raw tail for rev' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps long message text intact and shows complete choice history read-only', async () => {
    const longText = `diagnostic-${'x'.repeat(320)}`;
    debugResponse.messages[0]!.content = longText;
    debugResponse.choices = [
      {
        id: 'choice_db', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
        question: 'Choose database', options: [{ id: 'pg', label: 'Postgres' }], recommendation: null,
        status: 'pending_main_agent', selected: null, rationale: null,
        created_at: '2026-07-12T14:55:00.000Z', resolved_at: null,
      },
      {
        id: 'choice_cache', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
        question: 'Choose cache', options: [{ id: 'redis', label: 'Redis' }], recommendation: null,
        status: 'resolved', selected: 'redis', rationale: 'Existing operational experience',
        created_at: '2026-07-12T14:56:00.000Z', resolved_at: '2026-07-12T14:57:00.000Z',
      },
      {
        id: 'choice_queue', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
        question: 'Choose queue', options: [{ id: 'sqs', label: 'SQS' }], recommendation: null,
        status: 'expired', selected: null, rationale: null,
        created_at: '2026-07-12T14:57:00.000Z', resolved_at: null,
      },
      {
        id: 'choice_region', session_id: 'sess_1', requester_subagent_id: 'sub_1', target_peer_id: 'main_1',
        question: 'Choose region', options: [{ id: 'east', label: 'US East' }], recommendation: null,
        status: 'cancelled', selected: null, rationale: 'Deployment was cancelled',
        created_at: '2026-07-12T14:58:00.000Z', resolved_at: null,
      },
    ];

    renderAt('/core/sessions/sess_1');

    const content = await screen.findByText(longText);
    expect(content.closest('.core-message')).not.toBeNull();
    const pending = screen.getByText('Choose database').closest('article');
    const resolved = screen.getByText('Choose cache').closest('article');
    const expired = screen.getByText('Choose queue').closest('article');
    const cancelled = screen.getByText('Choose region').closest('article');
    expect(within(pending!).getByText('Pending')).toBeVisible();
    expect(within(resolved!).getByText('Resolved')).toBeVisible();
    expect(within(resolved!).getByText('Redis (redis)')).toBeVisible();
    expect(within(resolved!).getByText('Existing operational experience')).toBeVisible();
    expect(within(expired!).getByText('Expired')).toBeVisible();
    expect(within(cancelled!).getByText('Cancelled')).toBeVisible();
    expect(within(cancelled!).getByText('Deployment was cancelled')).toBeVisible();
    expect(screen.queryByRole('button', { name: /resolve|send|spawn|kill|terminate/i })).not.toBeInTheDocument();
  });

  it('renders separately labelled desktop regions and handles viewport changes with cleanup', async () => {
    const view = renderAt('/core/sessions/sess_1');

    await screen.findByText('Review payment retry logic');
    expect(screen.getByRole('region', { name: 'Messages' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Subagents' })).toBeVisible();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    viewport.setMatches(true);
    expect(screen.getByRole('tablist', { name: 'Core session detail' })).toBeVisible();
    expect(screen.getByRole('tabpanel', { name: 'Messages' })).toBeVisible();
    expect(document.querySelector('#core-panel-subagents')).toHaveAttribute('hidden');

    viewport.setMatches(false);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Messages' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Subagents' })).toBeVisible();

    view.unmount();
    expect(viewport.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('renders exclusive mobile tabs with valid relationships and roving keyboard navigation', async () => {
    viewport.setMatches(true);
    const user = userEvent.setup();
    renderAt('/core/sessions/sess_1');

    await screen.findByText('Review payment retry logic');
    const messagesTab = screen.getByRole('tab', { name: 'Messages' });
    const subagentsTab = screen.getByRole('tab', { name: 'Subagents' });
    expect(messagesTab).toHaveAttribute('aria-controls', 'core-panel-messages');
    expect(messagesTab).toHaveAttribute('aria-selected', 'true');
    expect(messagesTab).toHaveAttribute('tabindex', '0');
    expect(subagentsTab).toHaveAttribute('aria-controls', 'core-panel-subagents');
    expect(subagentsTab).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tabpanel', { name: 'Messages' })).toHaveAttribute('aria-labelledby', 'core-tab-messages');
    expect(document.querySelector('#core-panel-subagents')).toHaveAttribute('aria-labelledby', 'core-tab-subagents');
    expect(document.querySelector('#core-panel-subagents')).toHaveAttribute('hidden');

    messagesTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(subagentsTab).toHaveFocus();
    expect(subagentsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Subagents' })).toBeVisible();
    expect(document.querySelector('#core-panel-messages')).toHaveAttribute('hidden');

    await user.keyboard('{Home}');
    expect(messagesTab).toHaveFocus();
    await user.keyboard('{End}');
    expect(subagentsTab).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(messagesTab).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(subagentsTab).toHaveFocus();
  });

  it('lists live sessions with proxy-derived counts using at most four concurrent reads', async () => {
    sessionListResponse = Array.from({ length: 6 }, (_, index) => ({
      ...session,
      id: `sess_${index + 1}`,
      root_task: `Task ${index + 1}`,
      repo_path: index === 0 ? '/work/repository' : null,
    }));
    for (const listedSession of sessionListResponse) {
      debugById.set(listedSession.id, {
        ...structuredClone(debugBundle),
        session: listedSession,
        subagents: listedSession.id === 'sess_1' ? [
          { ...debugBundle.subagents[0]!, id: 'active', status: 'running' },
          { ...debugBundle.subagents[0]!, id: 'ready', alias: 'ready', status: 'ready' },
          { ...debugBundle.subagents[0]!, id: 'blocked', alias: 'blocked', status: 'native_cli_blocked' },
        ] : [],
      });
    }

    renderAt('/core/sessions');

    expect(await screen.findByRole('heading', { name: 'Core Sessions' })).toBeVisible();
    expect(await screen.findByRole('table', { name: 'Core Sessions' })).toBeVisible();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Updated', 'Task', 'Repository', 'Subagents', 'Active / Blocked',
    ]);
    const firstRow = screen.getByRole('link', { name: 'Task 1' }).closest('tr');
    expect(firstRow).not.toBeNull();
    expect(within(firstRow!).getByText('/work/repository')).toBeVisible();
    expect(within(firstRow!).getByText('3')).toBeVisible();
    expect(within(firstRow!).getByText('2 / 1')).toBeVisible();
    expect(maxConcurrentDebugReads).toBe(4);
  });

  it('retries Core offline reads without breaking Gateway navigation', async () => {
    sessionFailures = 1;
    const user = userEvent.setup();
    renderAt('/core/sessions');

    expect(await screen.findByRole('heading', { name: 'Core is offline' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry Core' }));
    expect(await screen.findByRole('table', { name: 'Core Sessions' })).toBeVisible();
  });

  it('uses one authenticated EventSource to invalidate live queries and expose reconnect state', async () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const view = renderAt('/core/sessions/sess_1');

    await screen.findByText('Review payment retry logic');
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/admin/core/events');
    expect(source.withCredentials).toBe(true);

    act(() => source.emitOpen());
    expect(screen.getByText('Core connected')).toBeVisible();
    act(() => source.emitMessage({ type: 'message_created', payload: { session_id: 'sess_1' } }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['core', 'sessions'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['core', 'session', 'sess_1'] });

    act(() => source.emitError());
    expect(screen.getByText('Core reconnecting')).toBeVisible();
    act(() => source.emitMessage({ type: 'core_connection', payload: { status: 'offline' } }));
    expect(screen.getByText('Core offline')).toBeVisible();

    view.unmount();
    expect(source.closed).toBe(true);
  });
});

describe('Core choice resolution', () => {
  it('shows queue context, option tradeoffs, and recommendation-only preselection', async () => {
    pendingChoices = choiceFixtures();
    const user = userEvent.setup();

    renderAt('/core/choices');

    const table = await screen.findByRole('table', { name: 'Pending Core Choices' });
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Age', 'Session task', 'Subagent', 'Question', 'Recommendation', '',
    ]);
    const databaseRow = screen.getByText('Choose database').closest('tr');
    expect(databaseRow).not.toBeNull();
    expect(within(databaseRow!).getByText('5 minutes ago')).toBeVisible();
    expect(within(databaseRow!).getByRole('link', { name: 'Review payment retry logic' })).toBeVisible();
    expect(within(databaseRow!).getByText('rev')).toBeVisible();
    expect(within(databaseRow!).getByText('Postgres')).toBeVisible();
    expect(within(databaseRow!).getByText('Matches production operations.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /send|spawn|kill|terminate/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolve Choose database' }));
    const recommendedDialog = screen.getByRole('dialog', { name: 'Choose database' });
    expect(within(recommendedDialog).getByRole('radio', { name: /Postgres/ })).toBeChecked();
    expect(within(recommendedDialog).getByRole('radio', { name: /SQLite/ })).not.toBeChecked();
    expect(within(recommendedDialog).getByText('Operationally familiar.')).toBeVisible();
    expect(within(recommendedDialog).getByText('Matches production operations.')).toBeVisible();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Resolve Choose cache' }));
    const unrecommendedDialog = screen.getByRole('dialog', { name: 'Choose cache' });
    expect(within(unrecommendedDialog).getAllByRole('radio').every((radio) => !radio.hasAttribute('checked') && !(radio as HTMLInputElement).checked)).toBe(true);
    expect(within(unrecommendedDialog).getByText('Shared service to operate.')).toBeVisible();
    expect(within(unrecommendedDialog).getByText('No cross-process sharing.')).toBeVisible();
    expect(within(unrecommendedDialog).queryByText('Recommendation')).not.toBeInTheDocument();
    expect(within(unrecommendedDialog).getByRole('button', { name: 'Submit choice' })).toBeDisabled();
  });

  it('renders and resolves each independent choice with its own options', async () => {
    pendingChoices = choiceFixtures();
    const user = userEvent.setup();

    renderAt('/core/choices');

    expect(await screen.findByText('Choose database')).toBeVisible();
    expect(screen.getByText('Choose cache')).toBeVisible();
    expect(screen.getByText('Choose region')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Resolve Choose cache' }));
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Redis/ })).not.toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Redis/ }));
    await user.type(screen.getByLabelText('Rationale'), 'Shared cache is required.');
    await user.click(screen.getByRole('button', { name: 'Submit choice' }));

    expect(mutations).toEqual([{
      path: '/admin/core/sessions/sess_1/choices/choice_cache/resolve',
      method: 'POST',
      body: { selected: 'redis', rationale: 'Shared cache is required.' },
    }]);
  });

  it('requires a selection, disables the dialog while pending, and removes only the resolved row', async () => {
    pendingChoices = choiceFixtures();
    let releaseResolution!: () => void;
    resolveGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const user = userEvent.setup();
    renderAt('/core/choices');

    await screen.findByText('Choose database');
    await user.click(screen.getByRole('button', { name: 'Resolve Choose database' }));
    await user.click(screen.getByRole('button', { name: 'Submit choice' }));

    const dialog = screen.getByRole('dialog', { name: 'Choose database' });
    expect(within(dialog).getByRole('button', { name: 'Submitting...' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('radio', { name: /Postgres/ })).toBeDisabled();
    expect(within(dialog).getByLabelText('Rationale')).toBeDisabled();
    const pendingStatus = within(dialog).getByRole('status');
    expect(document.activeElement).toBe(pendingStatus);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Choose database' })).toBeVisible();
    expect(document.activeElement).toBe(pendingStatus);
    await user.tab();
    expect(document.activeElement).toBe(pendingStatus);

    await act(async () => { releaseResolution(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Choose database')).not.toBeInTheDocument();
    expect(screen.getByText('Choose cache')).toBeVisible();
    expect(screen.getByText('Choose region')).toBeVisible();
    expect(mutations[0]?.body).toEqual({ selected: 'pg' });
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['core', 'session', 'sess_1'], exact: true }],
      [{ queryKey: ['core', 'choices', 'pending'], exact: true }],
    ]);
  });

  it('closes and refreshes the queue when Core reports an already-resolved conflict', async () => {
    pendingChoices = choiceFixtures();
    resolveConflict = true;
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const user = userEvent.setup();
    renderAt('/core/choices');

    await screen.findByText('Choose database');
    await user.click(screen.getByRole('button', { name: 'Resolve Choose database' }));
    await user.click(screen.getByRole('button', { name: 'Submit choice' }));

    expect(await screen.findByText('This choice was already resolved. Pending choices were refreshed.')).toBeVisible();
    await waitFor(() => expect(choiceReadCount).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Choose database')).not.toBeInTheDocument();
    expect(screen.getByText('Choose cache')).toBeVisible();
    expect(screen.getByText('Choose region')).toBeVisible();
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['core', 'choices', 'pending'], exact: true }],
    ]);
  });

  it('keeps Gateway available and retries when the Core choice queue is offline', async () => {
    pendingChoices = choiceFixtures();
    choiceFailures = 1;
    const user = userEvent.setup();
    renderAt('/core/choices');

    expect(await screen.findByRole('heading', { name: 'Core is offline' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Overview' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Retry Core' }));
    expect(await screen.findByRole('table', { name: 'Pending Core Choices' })).toBeVisible();
  });
});
