import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { adminFetch } from '../api/client.js';
import type { CliAvailability, CliAvailabilityResponse } from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { IconButton } from '../components/button.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';

const cliNames: Record<string, string> = {
  codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor Agent', opencode: 'OpenCode', antigravity: 'Antigravity',
};

function ceiling(item: CliAvailability, t: Translate): string {
  const value = item.capabilities;
  return [
    value.isolationLevel === 'strict' ? t('strict isolation') : t('best effort'),
    value.streamingMode === 'native' ? t('streaming') : t('no streaming'),
    value.toolBridge === 'structured_output' ? t('tools') : t('no tools'),
  ].join(' / ');
}

function scanTime(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale);
}

function columns(t: Translate, locale: string): Array<DataTableColumn<CliAvailability>> {
  return [
    { key: 'cli', label: 'CLI', width: '150px', render: (item) => cliNames[item.cli] ?? item.cli },
    { key: 'executable', label: t('Executable'), width: '110px', render: (item) => item.capabilities.available ? t('Available') : t('Unavailable') },
    { key: 'version', label: t('Version'), width: '110px', className: 'code-cell', render: (item) => item.capabilities.version ?? '-' },
    { key: 'ceiling', label: t('Static Ceiling'), width: '290px', render: (item) => ceiling(item, t) },
    { key: 'verified', label: t('Verification Count'), width: '140px', render: (item) => t('{count} verified', { count: item.verificationCount }) },
    { key: 'scan', label: t('Last Scan'), width: '190px', className: 'numeric', render: (item) => scanTime(item.scannedAt, locale) },
  ];
}

export function CliAvailabilityPage() {
  const { locale, t } = useI18n();
  const availability = useQuery({
    queryKey: ['cli-availability'],
    queryFn: () => adminFetch<CliAvailabilityResponse>('/admin/cli-availability'),
  });
  const refresh = useMutation({
    mutationFn: () => adminFetch<CliAvailabilityResponse>('/admin/cli-availability/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    }),
    onSuccess: (data) => queryClient.setQueryData(['cli-availability'], data),
  });
  return <>
    <div className="page-heading">
      <div><h1>{t('CLI Availability')}</h1><p>{t('Installed executables and static provider ceilings')}</p></div>
      <IconButton label={t('Refresh CLI availability')} disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw size={16} aria-hidden="true" /></IconButton>
    </div>
    <section className="table-section"><DataTable ariaLabel={t('CLI Availability')} columns={columns(t, locale)} rows={availability.data?.cli_availability ?? []} rowKey={(item) => item.cli} emptyTitle={availability.isError ? t('CLI availability unavailable') : t('No CLI scans')} /></section>
  </>;
}
