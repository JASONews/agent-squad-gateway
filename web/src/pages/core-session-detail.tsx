import { useQuery } from '@tanstack/react-query';
import { Copy, ScrollText } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type { CoreChoice, CoreDebugBundle, CoreMessage, CoreSubagent } from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { IconButton } from '../components/button.js';
import { RawTail } from '../components/raw-tail.js';
import { Timestamp } from '../components/timestamp.js';

interface CoreSessionDetailPageProps { sessionId: string }
const MESSAGE_LIMIT = 500;
const MOBILE_DETAIL_QUERY = '(max-width: 959px)';
type DetailPanel = 'messages' | 'subagents';

function useMediaQuery(query: string): boolean {
  const mediaQuery = useMemo(() => window.matchMedia(query), [query]);
  const [matches, setMatches] = useState(mediaQuery.matches);

  useEffect(() => {
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [mediaQuery]);

  return matches;
}

function MessageRow({ message, aliases }: { message: CoreMessage; aliases: Map<string, string> }) {
  const { t } = useI18n();
  const source = message.from_peer_id === null ? t('system') : aliases.get(message.from_peer_id) ?? message.from_peer_id;
  return (
    <article className="core-message" data-message-id={message.id}>
      <div className="core-message__meta">
        <strong>{message.kind}</strong>
        <span>{t('From {source}', { source })}</span>
        <Timestamp value={message.created_at} />
      </div>
      <p>{message.content ?? t('No message content.')}</p>
    </article>
  );
}

function SubagentRow({ subagent, onRawTail }: { subagent: CoreSubagent; onRawTail(): void }) {
  const { t } = useI18n();
  const [copyFailed, setCopyFailed] = useState(false);
  const copyNativeId = async () => {
    if (subagent.native_session_id === null) return;
    try {
      await navigator.clipboard.writeText(subagent.native_session_id);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <article className="core-subagent">
      <div className="core-subagent__heading">
        <strong>{subagent.alias}</strong>
        <span className={`semantic-status semantic-status--${['starting', 'ready', 'running'].includes(subagent.status) ? 'accent' : subagent.status === 'native_cli_blocked' ? 'warning' : 'muted'}`}>
          {t(subagent.status)}
        </span>
      </div>
      <dl className="core-facts">
        <div><dt>CLI</dt><dd>{subagent.cli_type}</dd></div>
        <div><dt>{t('Model / effort')}</dt><dd>{subagent.model ?? t('Default')} / {subagent.reasoning_effort ?? t('Default')}</dd></div>
        <div><dt>{t('Last seen')}</dt><dd><Timestamp value={subagent.last_seen_at} /></dd></div>
        <div><dt>{t('Last active')}</dt><dd><Timestamp value={subagent.last_seen_at} relative /></dd></div>
        <div>
          <dt>{t('Native session')}</dt>
          <dd className="native-session">
            <code>{subagent.native_session_id ?? t('Unavailable')}</code>
            <IconButton
              label={t('Copy native session ID for {alias}', { alias: subagent.alias })}
              disabled={subagent.native_session_id === null}
              onClick={() => void copyNativeId()}
            >
              <Copy size={15} aria-hidden="true" />
            </IconButton>
          </dd>
        </div>
      </dl>
      {copyFailed ? <p className="dialog-error" role="alert">{t('Session ID copy failed')}</p> : null}
      <IconButton label={t('View raw tail for {alias}', { alias: subagent.alias })} onClick={onRawTail}>
        <ScrollText size={16} aria-hidden="true" />
      </IconButton>
    </article>
  );
}

function ChoiceRow({ choice }: { choice: CoreChoice }) {
  const { t } = useI18n();
  const choiceStatusLabels: Record<CoreChoice['status'], string> = {
    pending_main_agent: t('Pending'),
    resolved: t('Resolved'),
    expired: t('Expired'),
    cancelled: t('Cancelled'),
  };
  const selectedOption = choice.options.find((option) => option.id === choice.selected);
  const selected = choice.selected === null
    ? null
    : selectedOption ? `${selectedOption.label} (${selectedOption.id})` : choice.selected;

  return (
    <article className="core-choice">
      <div className="core-choice__heading">
        <strong>{choice.question}</strong>
        <span className="semantic-status semantic-status--muted">{choiceStatusLabels[choice.status]}</span>
      </div>
      {selected !== null || choice.rationale !== null ? (
        <dl className="core-choice__facts">
          {selected !== null ? <div><dt>{t('Selection')}</dt><dd>{selected}</dd></div> : null}
          {choice.rationale !== null ? <div><dt>{t('Rationale')}</dt><dd>{choice.rationale}</dd></div> : null}
        </dl>
      ) : null}
    </article>
  );
}

export function CoreSessionDetailPage({ sessionId }: CoreSessionDetailPageProps) {
  const { t } = useI18n();
  const isMobile = useMediaQuery(MOBILE_DETAIL_QUERY);
  const [activePanel, setActivePanel] = useState<DetailPanel>('messages');
  const [rawTailSubagentId, setRawTailSubagentId] = useState<string | null>(null);
  const messagesTabRef = useRef<HTMLButtonElement>(null);
  const subagentsTabRef = useRef<HTMLButtonElement>(null);
  const query = useQuery({
    queryKey: ['core', 'session', sessionId],
    queryFn: () => adminFetch<CoreDebugBundle>(`/admin/core/sessions/${encodeURIComponent(sessionId)}/debug`),
  });
  const aliases = useMemo(
    () => new Map(query.data?.subagents.map((subagent) => [subagent.id, subagent.alias]) ?? []),
    [query.data?.subagents],
  );
  const visibleMessages = useMemo(() => [...(query.data?.messages ?? [])]
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
    .slice(-MESSAGE_LIMIT), [query.data?.messages]);
  const activateTab = (panel: DetailPanel) => {
    setActivePanel(panel);
    (panel === 'messages' ? messagesTabRef : subagentsTabRef).current?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, panel: DetailPanel) => {
    let nextPanel: DetailPanel | null = null;
    if (event.key === 'Home') nextPanel = 'messages';
    if (event.key === 'End') nextPanel = 'subagents';
    if (event.key === 'ArrowLeft') nextPanel = panel === 'messages' ? 'subagents' : 'messages';
    if (event.key === 'ArrowRight') nextPanel = panel === 'messages' ? 'subagents' : 'messages';
    if (nextPanel === null) return;
    event.preventDefault();
    activateTab(nextPanel);
  };

  if (query.isPending) return <p role="status">{t('Loading Core session...')}</p>;
  if (query.isError) return (
    <section className="core-unavailable" aria-labelledby="core-unavailable-title">
      <h1 id="core-unavailable-title">{t('Core session unavailable')}</h1>
      <p>{t('Gateway navigation remains available while Core reconnects.')}</p>
      <button type="button" onClick={() => void query.refetch()}>{t('Retry Core')}</button>
    </section>
  );

  const { session, subagents, choices } = query.data;
  const rawTailSubagent = rawTailSubagentId === null
    ? null
    : subagents.find((subagent) => subagent.id === rawTailSubagentId) ?? null;
  return <>
    <header className="page-heading core-detail-heading">
      <div>
        <a className="core-back-link" href="#/core/sessions">{t('Core Sessions')}</a>
        <h1>{session.root_task}</h1>
        <p><code>{session.repo_path ?? t('No repository')}</code> <span aria-hidden="true">/</span> {session.id}</p>
      </div>
    </header>

    {isMobile ? (
      <div className="core-tabs" role="tablist" aria-label={t('Core session detail')}>
        <button
          id="core-tab-messages"
          ref={messagesTabRef}
          type="button"
          role="tab"
          tabIndex={activePanel === 'messages' ? 0 : -1}
          aria-selected={activePanel === 'messages'}
          aria-controls="core-panel-messages"
          onClick={() => setActivePanel('messages')}
          onKeyDown={(event) => handleTabKeyDown(event, 'messages')}
        >{t('Messages')}</button>
        <button
          id="core-tab-subagents"
          ref={subagentsTabRef}
          type="button"
          role="tab"
          tabIndex={activePanel === 'subagents' ? 0 : -1}
          aria-selected={activePanel === 'subagents'}
          aria-controls="core-panel-subagents"
          onClick={() => setActivePanel('subagents')}
          onKeyDown={(event) => handleTabKeyDown(event, 'subagents')}
        >{t('Subagents')}</button>
      </div>
    ) : null}

    <div className="core-detail-grid">
      <section
        id="core-panel-messages"
        className="core-panel core-panel--messages"
        role={isMobile ? 'tabpanel' : 'region'}
        aria-labelledby={isMobile ? 'core-tab-messages' : 'core-heading-messages'}
        hidden={isMobile && activePanel !== 'messages'}
      >
        {!isMobile ? <h2 className="core-panel__title" id="core-heading-messages">{t('Messages')}</h2> : null}
        {visibleMessages.length === 0 ? <p className="core-empty">{t('No messages.')}</p> : visibleMessages.map((message) => (
          <MessageRow key={message.id} message={message} aliases={aliases} />
        ))}
        {choices.map((choice) => <ChoiceRow choice={choice} key={choice.id} />)}
      </section>
      <section
        id="core-panel-subagents"
        className="core-panel core-panel--subagents"
        role={isMobile ? 'tabpanel' : 'region'}
        aria-labelledby={isMobile ? 'core-tab-subagents' : 'core-heading-subagents'}
        hidden={isMobile && activePanel !== 'subagents'}
      >
        {!isMobile ? <h2 className="core-panel__title" id="core-heading-subagents">{t('Subagents')}</h2> : null}
        {subagents.length === 0 ? <p className="core-empty">{t('No subagents.')}</p> : subagents.map((subagent) => (
          <SubagentRow key={subagent.id} subagent={subagent} onRawTail={() => setRawTailSubagentId(subagent.id)} />
        ))}
      </section>
    </div>
    {rawTailSubagent ? (
      <RawTail
        alias={rawTailSubagent.alias}
        tail={rawTailSubagent.raw_tail}
        onClose={() => setRawTailSubagentId(null)}
      />
    ) : null}
  </>;
}
