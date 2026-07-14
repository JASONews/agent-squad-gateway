import { useMutation, useQuery } from '@tanstack/react-query';
import { adminFetch } from '../api/client.js';
import type { ExtensionsResponse, GatewayExtension } from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Toggle } from '../components/toggle.js';

const names: Record<string, string> = { openai: 'OpenAI' };

export function ExtensionsPage() {
  const { t } = useI18n();
  const extensions = useQuery({ queryKey: ['extensions'], queryFn: () => adminFetch<ExtensionsResponse>('/admin/extensions') });
  const toggle = useMutation({
    mutationFn: ({ item, enabled }: { item: GatewayExtension; enabled: boolean }) => adminFetch(`/admin/extensions/${encodeURIComponent(item.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['extensions'] }),
  });
  const columns: Array<DataTableColumn<GatewayExtension>> = [
    { key: 'id', label: t('Extension'), width: '180px', render: (item) => names[item.id] ?? item.id },
    { key: 'version', label: t('Version'), width: '120px', className: 'code-cell', render: (item) => item.version },
    { key: 'gateway', label: t('Required Gateway'), width: '150px', className: 'code-cell', render: (item) => item.requiredGatewayVersion },
    { key: 'endpoint', label: t('Endpoint'), width: '180px', className: 'code-cell', render: (item) => item.endpoint },
    { key: 'health', label: t('Endpoint Status'), width: '150px', render: (item) => item.health.ok ? t('Operational') : item.health.detail ?? t('Unavailable') },
    { key: 'enabled', label: t('Enabled'), width: '100px', render: (item) => <Toggle label={t('Enable {name}', { name: names[item.id] ?? item.id })} checked={item.enabled} disabled={toggle.isPending} onCheckedChange={(enabled) => toggle.mutate({ item, enabled })} /> },
  ];
  return <>
    <div className="page-heading"><div><h1>{t('Extensions')}</h1><p>{t('Compiled Gateway protocol manifests and endpoint state')}</p></div><span className="record-count">{t('{count} extensions', { count: extensions.data?.extensions.length ?? 0 })}</span></div>
    <section className="table-section"><DataTable ariaLabel={t('Extensions')} columns={columns} rows={extensions.data?.extensions ?? []} rowKey={(item) => item.id} emptyTitle={extensions.isError ? t('Extensions unavailable') : t('No compiled extensions')} /></section>
  </>;
}
