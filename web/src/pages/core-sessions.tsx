import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '../api/client.js';
import type { CoreDebugBundle, CoreSession, CoreSessionsResponse } from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Timestamp } from '../components/timestamp.js';

interface CoreSessionRow extends CoreSession {
  subagentCount: number;
  activeCount: number;
  blockedCount: number;
}

const activeStatuses = new Set(['starting', 'ready', 'running']);

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

async function loadSessions(): Promise<CoreSessionRow[]> {
  const response = await adminFetch<CoreSessionsResponse>('/admin/core/sessions');
  const bundles = await mapConcurrent(response.sessions, 4, (session) =>
    adminFetch<CoreDebugBundle>(`/admin/core/sessions/${encodeURIComponent(session.id)}/debug`));
  return response.sessions.map((session, index) => {
    const subagents = bundles[index]!.subagents;
    return {
      ...session,
      subagentCount: subagents.length,
      activeCount: subagents.filter((subagent) => activeStatuses.has(subagent.status)).length,
      blockedCount: subagents.filter((subagent) => subagent.status === 'native_cli_blocked').length,
    };
  }).sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
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
  const query = useQuery({ queryKey: ['core', 'sessions'], queryFn: loadSessions });

  return <>
    <header className="page-heading">
      <div>
        <h1>{t('Core Sessions')}</h1>
        <p>{t('Live read-only session history from Core.')}</p>
      </div>
      {query.data ? <span className="record-count">{t('{count} sessions', { count: query.data.length })}</span> : null}
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
          rows={query.data}
          rowKey={(row) => row.id}
          emptyTitle={t('No live Core sessions')}
        />
      </section>
    )}
  </>;
}
