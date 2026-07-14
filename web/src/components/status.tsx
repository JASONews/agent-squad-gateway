import type { RunStatus } from '../api/types.js';
import { useI18n } from '../app/i18n.js';

type StatusTone = 'success' | 'warning' | 'danger' | 'muted' | 'accent';

const runTone: Record<RunStatus, StatusTone> = {
  queued: 'warning',
  running: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'muted',
  interrupted: 'warning',
};

export function Status({ status }: { status: RunStatus }) {
  const { t } = useI18n();
  return <span className={`semantic-status semantic-status--${runTone[status]}`}>{t(status)}</span>;
}

export function HealthStatus({ ok, degraded = false }: { ok: boolean; degraded?: boolean }) {
  const { t } = useI18n();
  const tone = ok ? 'success' : degraded ? 'warning' : 'danger';
  const label = ok ? 'Operational' : degraded ? 'Degraded' : 'Unavailable';
  return <span className={`semantic-status semantic-status--${tone}`}>{t(label)}</span>;
}
