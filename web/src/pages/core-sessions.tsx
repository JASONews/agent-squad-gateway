import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type { CoreDebugBundle, CoreSession, CoreSessionsResponse } from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { IconButton } from '../components/button.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Timestamp } from '../components/timestamp.js';

interface CoreSessionRow extends CoreSession {
  subagentCount: number;
  activeCount: number;
  blockedCount: number;
}

interface CoreSessionPage {
  rows: CoreSessionRow[];
  total: number;
  page: number;
  pageCount: number;
}

const activeStatuses = new Set(['starting', 'ready', 'running']);
const PAGE_SIZE = 20;

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const result = new Array<Output>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await map(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

function compareSessionsByRecentActivity(left: CoreSession, right: CoreSession): number {
  return Date.parse(right.updated_at) - Date.parse(left.updated_at)
    || Date.parse(right.created_at) - Date.parse(left.created_at)
    || right.id.localeCompare(left.id);
}

async function loadSessions(requestedPage: number): Promise<CoreSessionPage> {
  const response = await adminFetch<CoreSessionsResponse>('/admin/core/sessions');
  const sessions = [...response.sessions].sort(compareSessionsByRecentActivity);
  const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const pageSessions = sessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const bundles = await mapConcurrent(pageSessions, 4, (session) =>
    adminFetch<CoreDebugBundle>(`/admin/core/sessions/${encodeURIComponent(session.id)}/debug`));
  const rows = pageSessions.map((session, index) => {
    const subagents = bundles[index]!.subagents;
    return {
      ...session,
      subagentCount: subagents.length,
      activeCount: subagents.filter((subagent) => activeStatuses.has(subagent.status)).length,
      blockedCount: subagents.filter((subagent) => subagent.status === 'native_cli_blocked').length,
    };
  });
  return { rows, total: sessions.length, page, pageCount };
}

function sessionColumns(t: Translate): Array<DataTableColumn<CoreSessionRow>> {
  return [
  {
    key: 'updated', label: t('Updated'), width: '170px', className: 'numeric',
    render: (row) => <Timestamp value={row.updated_at} relative />,
  },
  {
    key: 'task', label: t('Task'), width: '34%',
    render: (row) => <a className="core-session-link" href={`#/core/sessions/${encodeURIComponent(row.id)}`}>{row.root_task}</a>,
  },
  {
    key: 'repository', label: t('Repository'), width: '28%', className: 'code-cell core-wrap-cell',
    render: (row) => row.repo_path ?? t('No repository'),
  },
  {
    key: 'subagents', label: t('Subagents'), width: '100px', className: 'numeric',
    render: (row) => row.subagentCount,
  },
  {
    key: 'active-blocked', label: t('Active / Blocked'), width: '140px', className: 'numeric',
    render: (row) => `${row.activeCount} / ${row.blockedCount}`,
  },
  ];
}

export function CoreSessionsPage() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['core', 'sessions', page],
    queryFn: () => loadSessions(page),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (!query.isPlaceholderData && query.data && page !== query.data.page) setPage(query.data.page);
  }, [page, query.data, query.isPlaceholderData]);

  return <>
    <header className="page-heading">
      <div>
        <h1>{t('Core Sessions')}</h1>
        <p>{t('Live read-only session history from Core.')}</p>
      </div>
      {query.data ? <span className="record-count">{t('{count} sessions', { count: query.data.total })}</span> : null}
    </header>
    {query.isPending ? <p role="status">{t('Loading Core sessions...')}</p> : query.isError ? (
      <section className="core-unavailable" aria-labelledby="core-sessions-unavailable-title">
        <h2 id="core-sessions-unavailable-title">{t('Core is offline')}</h2>
        <p>{t('Gateway remains available. Retry when Core is reachable.')}</p>
        <button type="button" onClick={() => void query.refetch()}>{t('Retry Core')}</button>
      </section>
    ) : (
      <section className="table-section">
        <DataTable
          ariaLabel={t('Core Sessions')}
          columns={sessionColumns(t)}
          rows={query.data?.rows ?? []}
          rowKey={(row) => row.id}
          emptyTitle={t('No live Core sessions')}
        />
        {query.data && query.data.pageCount > 1 ? (
          <nav className="core-pagination" aria-label={t('Core session pages')}>
            <IconButton
              label={t('Previous page')}
              disabled={query.isFetching || query.data.page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </IconButton>
            <span className="core-pagination__status" aria-live="polite">
              {t('Page {page} of {pages}', { page: query.data.page, pages: query.data.pageCount })}
            </span>
            <IconButton
              label={t('Next page')}
              disabled={query.isFetching || query.data.page >= query.data.pageCount}
              onClick={() => setPage((current) => current + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </IconButton>
          </nav>
        ) : null}
      </section>
    )}
  </>;
}
