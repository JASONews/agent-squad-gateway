import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { adminFetch } from '../api/client.js';
import type {
  CoreChoice,
  CoreChoicesResponse,
  CoreDebugBundle,
  CoreSessionsResponse,
} from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { Button } from '../components/button.js';
import { ChoiceDialog } from '../components/choice-dialog.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Timestamp } from '../components/timestamp.js';

const PENDING_CHOICES_QUERY = ['core', 'choices', 'pending'] as const;

interface PendingChoiceRow {
  choice: CoreChoice;
  sessionTask: string;
  subagent: string;
}

async function loadPendingChoices(): Promise<PendingChoiceRow[]> {
  const [{ choices }, { sessions }] = await Promise.all([
    adminFetch<CoreChoicesResponse>('/admin/core/choices?status=pending'),
    adminFetch<CoreSessionsResponse>('/admin/core/sessions'),
  ]);
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const sessionIds = [...new Set(choices.map((choice) => choice.session_id))];
  const debug = await Promise.all(sessionIds.map((sessionId) =>
    adminFetch<CoreDebugBundle>(`/admin/core/sessions/${encodeURIComponent(sessionId)}/debug`),
  ));
  const debugBySession = new Map(debug.map((bundle) => [bundle.session.id, bundle]));

  return choices.map((choice) => ({
    choice,
    sessionTask: sessionById.get(choice.session_id)?.root_task ?? choice.session_id,
    subagent: debugBySession.get(choice.session_id)?.subagents
      .find((subagent) => subagent.id === choice.requester_subagent_id)?.alias
      ?? choice.requester_subagent_id,
  }));
}

export function CoreChoicesPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: PENDING_CHOICES_QUERY, queryFn: loadPendingChoices });
  const [activeChoice, setActiveChoice] = useState<CoreChoice | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resolved = (choice: CoreChoice) => {
    queryClient.setQueryData<PendingChoiceRow[]>(PENDING_CHOICES_QUERY, (rows) =>
      rows?.filter((row) => !(row.choice.id === choice.id && row.choice.session_id === choice.session_id)),
    );
    setActiveChoice(null);
    void queryClient.invalidateQueries({ queryKey: ['core', 'session', choice.session_id], exact: true });
    void queryClient.invalidateQueries({ queryKey: PENDING_CHOICES_QUERY, exact: true });
  };

  const conflict = () => {
    setActiveChoice(null);
    setNotice('This choice was already resolved. Pending choices were refreshed.');
    void queryClient.invalidateQueries({ queryKey: PENDING_CHOICES_QUERY, exact: true });
  };

  const columns: Array<DataTableColumn<PendingChoiceRow>> = [
    { key: 'age', label: t('Age'), width: '110px', render: ({ choice }) => <Timestamp value={choice.created_at} relative /> },
    { key: 'task', label: t('Session task'), width: '220px', className: 'core-wrap-cell', render: ({ choice, sessionTask }) => <a href={`#/core/sessions/${encodeURIComponent(choice.session_id)}`}>{sessionTask}</a> },
    { key: 'subagent', label: t('Subagent'), width: '110px', render: (row) => row.subagent },
    { key: 'question', label: t('Question'), width: '220px', className: 'core-wrap-cell', render: ({ choice }) => choice.question },
    {
      key: 'recommendation', label: t('Recommendation'), width: '280px', className: 'core-wrap-cell',
      render: ({ choice }) => choice.recommendation
        ? <span className="choice-cell-detail"><strong>{choice.options.find((option) => option.id === choice.recommendation?.option_id)?.label ?? choice.recommendation.option_id}</strong><small>{choice.recommendation.reason}</small></span>
        : <span className="muted">{t('None')}</span>,
    },
    { key: 'actions', label: '', width: '100px', className: 'actions-cell', render: ({ choice }) => <Button type="button" aria-label={t('Resolve {question}', { question: choice.question })} onClick={() => { setNotice(null); setActiveChoice(choice); }}>{t('Resolve')}</Button> },
  ];

  return <>
    <header className="page-heading">
      <div>
        <h1>{t('Pending Core Choices')}</h1>
        <p>{t('Explicit decisions requested by Core subagents.')}</p>
      </div>
      {query.data ? <span className="record-count">{t('{count} pending', { count: query.data.length })}</span> : null}
    </header>
    {notice ? <p className="operation-notice" role="status">{t(notice)}</p> : null}
    {query.isPending ? <p role="status">{t('Loading pending Core choices...')}</p> : query.isError ? (
      <section className="core-unavailable" aria-labelledby="core-choices-unavailable-title">
        <h2 id="core-choices-unavailable-title">{t('Core is offline')}</h2>
        <p>{t('Gateway remains available. Retry when Core is reachable.')}</p>
        <Button type="button" onClick={() => void query.refetch()}>{t('Retry Core')}</Button>
      </section>
    ) : (
      <section className="table-section">
        <DataTable ariaLabel={t('Pending Core Choices')} columns={columns} rows={query.data} rowKey={(row) => row.choice.id} emptyTitle={t('No pending Core choices')} />
      </section>
    )}
    {activeChoice ? (
      <ChoiceDialog
        choice={activeChoice}
        onClose={() => setActiveChoice(null)}
        onResolved={() => resolved(activeChoice)}
        onConflict={conflict}
      />
    ) : null}
  </>;
}
