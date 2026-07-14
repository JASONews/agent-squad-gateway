import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleStop } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminFetch } from '../api/client.js';
import type { GatewayRun, RunsResponse, RunStatus } from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { Button, IconButton } from '../components/button.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { useFocusTrap } from '../components/focus-trap.js';
import { Status } from '../components/status.js';

interface RunFilters {
  status: '' | RunStatus;
  targetId: string;
  clientId: string;
  timeRange: '1h' | '24h' | '7d' | 'all';
}

const initialFilters: RunFilters = { status: '', targetId: '', clientId: '', timeRange: 'all' };

function runsPath(filters: RunFilters): string {
  const query = new URLSearchParams({ limit: '100' });
  if (filters.status) query.set('status', filters.status);
  if (filters.targetId) query.set('target_id', filters.targetId);
  if (filters.clientId) query.set('client_id', filters.clientId);
  return `/admin/runs?${query.toString()}`;
}

function formatTimestamp(value: string | null, locale: string): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(date);
}

function formatLatency(value: number | null): string {
  if (value === null) return '-';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function runColumns(t: Translate, locale: string, onCancel?: (run: GatewayRun) => void): Array<DataTableColumn<GatewayRun>> {
  return [
    {
      key: 'started', label: t('Started'), width: '162px', className: 'numeric',
      render: (run) => <time dateTime={run.startedAt ?? run.queuedAt}>{formatTimestamp(run.startedAt ?? run.queuedAt, locale)}</time>,
    },
    { key: 'client', label: t('Client'), width: '118px', render: (run) => run.clientId ?? t('system') },
    { key: 'extension', label: t('Extension'), width: '98px', render: (run) => run.extensionId },
    { key: 'endpoint', label: t('Endpoint'), width: '176px', className: 'code-cell', render: (run) => run.endpoint },
    { key: 'target', label: t('Target'), width: '132px', render: (run) => run.targetId },
    { key: 'status', label: t('Status'), width: '92px', render: (run) => <Status status={run.status} /> },
    { key: 'latency', label: t('Latency'), width: '82px', className: 'numeric', render: (run) => formatLatency(run.latencyMs) },
    { key: 'error', label: t('Error'), width: '144px', className: 'code-cell', render: (run) => run.errorCode ?? '-' },
    {
      key: 'actions', label: t('Actions'), width: '72px', className: 'actions-cell',
      render: (run) => onCancel && (run.status === 'queued' || run.status === 'running') ? (
        <IconButton label={t('Cancel run {id}', { id: run.id })} variant="quiet" onClick={() => onCancel(run)}>
          <CircleStop size={16} aria-hidden="true" />
        </IconButton>
      ) : '-',
    },
  ];
}

export function RunsTable({ runs, onCancel }: { runs: GatewayRun[]; onCancel?: (run: GatewayRun) => void }) {
  const { locale, t } = useI18n();
  return (
    <DataTable
      ariaLabel={t('API Runs')}
      columns={runColumns(t, locale, onCancel)}
      rows={runs}
      rowKey={(run) => run.id}
      emptyTitle={t('No API runs')}
    />
  );
}

function withinTimeRange(run: GatewayRun, range: RunFilters['timeRange']): boolean {
  if (range === 'all') return true;
  const duration = range === '1h' ? 3_600_000 : range === '24h' ? 86_400_000 : 604_800_000;
  return Date.now() - Date.parse(run.queuedAt) <= duration;
}

export function RunsPage() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<RunFilters>(initialFilters);
  const [cancelCandidate, setCancelCandidate] = useState<GatewayRun | null>(null);
  const [knownRuns, setKnownRuns] = useState<GatewayRun[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRunningRef = useRef<HTMLButtonElement>(null);
  const closeCancellation = useCallback(() => setCancelCandidate(null), []);
  const query = useQuery({
    queryKey: ['runs', 'list', filters.status, filters.targetId, filters.clientId],
    queryFn: () => adminFetch<RunsResponse>(runsPath(filters)),
  });

  useEffect(() => {
    if (!query.data) return;
    setKnownRuns((current) => {
      const byId = new Map(current.map((run) => [run.id, run]));
      query.data.runs.forEach((run) => byId.set(run.id, run));
      return [...byId.values()];
    });
  }, [query.data]);

  const targetOptions = useMemo(
    () => [...new Set(knownRuns.map((run) => run.targetId))].sort(),
    [knownRuns],
  );
  const clientOptions = useMemo(
    () => [...new Set(knownRuns.flatMap((run) => run.clientId ? [run.clientId] : []))].sort(),
    [knownRuns],
  );
  const visibleRuns = (query.data?.runs ?? []).filter((run) => withinTimeRange(run, filters.timeRange));
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    if (!shell) return;
    if (cancelCandidate) shell.setAttribute('inert', '');
    else shell.removeAttribute('inert');
    return () => shell.removeAttribute('inert');
  }, [cancelCandidate]);
  useFocusTrap(cancelCandidate !== null, dialogRef, closeCancellation, keepRunningRef);
  const cancellation = useMutation({
    mutationFn: (runId: string) => adminFetch<{ cancelled: true; id: string }>(
      `/admin/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' },
    ),
    onSuccess: async () => {
      setCancelCandidate(null);
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const updateFilter = <Key extends keyof RunFilters>(key: Key, value: RunFilters[Key]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('API Runs')}</h1>
          <p>{t('Gateway-owned provider invocations')}</p>
        </div>
        <span className="record-count">{t('{count} runs', { count: visibleRuns.length })}</span>
      </div>

      <section className="filter-bar" aria-label={t('Run filters')}>
        <label>{t('Status')}
          <select value={filters.status} onChange={(event) => updateFilter('status', event.target.value as RunFilters['status'])}>
            <option value="">{t('All statuses')}</option>
            {(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as RunStatus[])
              .map((status) => <option key={status} value={status}>{t(status)}</option>)}
          </select>
        </label>
        <label>{t('Target')}
          <select value={filters.targetId} onChange={(event) => updateFilter('targetId', event.target.value)}>
            <option value="">{t('All targets')}</option>
            {targetOptions.map((target) => <option key={target} value={target}>{target}</option>)}
          </select>
        </label>
        <label>{t('Client')}
          <select value={filters.clientId} onChange={(event) => updateFilter('clientId', event.target.value)}>
            <option value="">{t('All clients')}</option>
            {clientOptions.map((client) => <option key={client} value={client}>{client}</option>)}
          </select>
        </label>
        <label>{t('Time range')}
          <select value={filters.timeRange} onChange={(event) => updateFilter('timeRange', event.target.value as RunFilters['timeRange'])}>
            <option value="1h">{t('Last hour')}</option>
            <option value="24h">{t('Last 24 hours')}</option>
            <option value="7d">{t('Last 7 days')}</option>
            <option value="all">{t('All time')}</option>
          </select>
        </label>
      </section>

      <section className="table-section" aria-labelledby="runs-table-title">
        <h2 id="runs-table-title" className="visually-hidden">{t('API Runs')}</h2>
        <RunsTable runs={visibleRuns} onCancel={setCancelCandidate} />
      </section>

      {cancelCandidate ? createPortal((
        <div className="dialog-layer">
          <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-run-title" tabIndex={-1}>
            <h2 id="cancel-run-title">{t('Cancel API run')}</h2>
            <dl className="dialog-facts">
              <div><dt>{t('Run')}</dt><dd>{cancelCandidate.id}</dd></div>
              <div><dt>{t('Target')}</dt><dd>{cancelCandidate.targetId}</dd></div>
            </dl>
            {cancellation.isError ? <p className="dialog-error">{t('Cancellation failed')}</p> : null}
            <div className="dialog-actions">
              <Button ref={keepRunningRef} variant="quiet" onClick={closeCancellation}>{t('Keep running')}</Button>
              <Button
                variant="danger"
                disabled={cancellation.isPending}
                onClick={() => cancellation.mutate(cancelCandidate.id)}
              >
                <CircleStop size={16} aria-hidden="true" />
                {t('Confirm cancel')}
              </Button>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </>
  );
}
