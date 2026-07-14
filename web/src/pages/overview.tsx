import { useQuery } from '@tanstack/react-query';
import { adminFetch } from '../api/client.js';
import type { CoreHealth, GatewayHealth, OverviewRunsResponse } from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { EmptyState } from '../components/empty-state.js';
import { HealthStatus } from '../components/status.js';
import { RunsTable } from './runs.js';

export function OverviewPage() {
  const { t } = useI18n();
  const gateway = useQuery({ queryKey: ['gateway-health'], queryFn: () => adminFetch<GatewayHealth>('/health') });
  const core = useQuery({ queryKey: ['core-health'], queryFn: () => adminFetch<CoreHealth>('/admin/core/health') });
  const recentRuns = useQuery({
    queryKey: ['runs', 'overview'],
    queryFn: () => adminFetch<OverviewRunsResponse>('/admin/runs/overview'),
  });
  const runs = recentRuns.data?.runs ?? [];
  const pressure = recentRuns.data?.queuePressure ?? [];

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('Overview')}</h1>
          <p>{t('Gateway and Core operational state')}</p>
        </div>
        <span className="record-count">{t('Live status')}</span>
      </div>

      <section className="metric-band" aria-label={t('Operations status')}>
        <div className="metric-cell">
          <span>Gateway</span>
          <strong><HealthStatus ok={gateway.data?.ok === true} /></strong>
          <small>{gateway.data?.version ?? t('Checking')}</small>
        </div>
        <div className="metric-cell">
          <span>Core</span>
          <strong><HealthStatus ok={core.data?.ok === true} degraded={core.data?.connection?.status === 'degraded' || core.isError} /></strong>
          <small>{core.data?.version ?? t('Connection')}</small>
        </div>
        <div className="metric-cell">
          <span>{t('Active Runs')}</span>
          <strong className="metric-value">{recentRuns.data?.activeRunCount ?? 0}</strong>
          <small>{t('queued and running')}</small>
        </div>
        <div className="metric-cell">
          <span>{t('Verified Targets')}</span>
          <strong className="metric-value">{recentRuns.data?.verifiedTargetCount ?? 0}</strong>
          <small>{t('capability checked')}</small>
        </div>
      </section>

      <section className="operations-section" aria-label={t('Queue pressure')}>
        <div className="section-heading">
          <h2>{t('Queue pressure')}</h2>
          <span>{t('{count} queued', { count: pressure.reduce((sum, target) => sum + target.queued, 0) })}</span>
        </div>
        {pressure.length === 0 ? <EmptyState title={t('No active queues')} /> : (
          <div className="pressure-list">
            <div className="pressure-row pressure-row--header">
              <span>{t('Target')}</span><span>{t('Queued')}</span><span>{t('Running')}</span>
            </div>
            {pressure.map((target) => (
              <div className="pressure-row" key={target.targetId}>
                <strong>{target.targetId}</strong>
                <span>{target.queued}</span>
                <span>{target.running}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="operations-section" aria-labelledby="recent-runs-title">
        <div className="section-heading">
          <h2 id="recent-runs-title">{t('Recent API Runs')}</h2>
          <a href="#/runs">{t('View all')}</a>
        </div>
        <RunsTable runs={runs.slice(0, 20)} />
      </section>
    </>
  );
}
