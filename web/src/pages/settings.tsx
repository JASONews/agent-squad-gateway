import { useMutation, useQuery } from '@tanstack/react-query';
import { LogOut, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type { SettingsResponse, WebUiAuthMode } from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { Button } from '../components/button.js';

export function SettingsPage({
  onLogout,
  webUiAuth,
}: {
  onLogout(): Promise<void>;
  webUiAuth: WebUiAuthMode;
}) {
  const { t } = useI18n();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => adminFetch<SettingsResponse>('/admin/settings'),
  });
  const [coreUrl, setCoreUrl] = useState('');
  const updateCore = useMutation({
    mutationFn: () => adminFetch<{ base_url: string }>('/admin/settings/core', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base_url: coreUrl }),
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['settings'] }); },
  });

  useEffect(() => {
    if (settings.data) setCoreUrl(settings.data.core.base_url);
  }, [settings.data]);

  const value = settings.data;
  return <>
    <div className="page-heading">
      <div><h1>{t('Settings')}</h1><p>{t('Gateway connection and local policy')}</p></div>
    </div>
    <section className="settings-section" aria-labelledby="core-settings-title">
      <div className="section-heading"><h2 id="core-settings-title">{t('Core connection')}</h2><span>{value?.core.status ? t(value.core.status) : t('unknown')}</span></div>
      <div className="settings-core-row">
        <label className="field"><span>{t('Core URL')}</span><input value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} /></label>
        <Button disabled={!coreUrl || updateCore.isPending} onClick={() => updateCore.mutate()}><Save size={15} aria-hidden="true" /> {t('Save Core URL')}</Button>
      </div>
      {updateCore.isError ? <p role="alert" className="dialog-error">{t('Core URL must be a loopback HTTP URL')}</p> : null}
    </section>
    <section className="settings-section" aria-labelledby="gateway-definitions-title">
      <div className="section-heading"><h2 id="gateway-definitions-title">{t('Gateway definitions')}</h2><span>{t('Read only')}</span></div>
      {value ? <dl className="definition-list">
        <div><dt>{t('Bind address')}</dt><dd>{value.bind_address}</dd></div>
        <div><dt>{t('Config path')}</dt><dd>{value.state_paths.config}</dd></div>
        <div><dt>{t('Database path')}</dt><dd>{value.state_paths.database}</dd></div>
        <div><dt>{t('Master key path')}</dt><dd>{value.state_paths.master_key}</dd></div>
        <div><dt>{t('Admin secret path')}</dt><dd>{value.state_paths.admin_secret}</dd></div>
        <div><dt>{t('Metadata retention')}</dt><dd>{t('{count} days', { count: value.retention.metadata_days })}</dd></div>
        <div><dt>{t('Replay TTL')}</dt><dd>{t('{count} minutes', { count: value.retention.replay_ttl_minutes })}</dd></div>
        <div><dt>{t('Network policy')}</dt><dd>{value.security.bind}</dd></div>
        <div><dt>CORS</dt><dd>{value.security.cors}</dd></div>
        <div><dt>{t('Web UI authentication')}</dt><dd>{value.security.web_ui_auth}</dd></div>
      </dl> : <p className="muted">{settings.isError ? t('Settings unavailable') : t('Loading settings')}</p>}
    </section>
    {webUiAuth === 'token' ? (
      <section className="settings-section" aria-labelledby="session-settings-title">
        <div className="section-heading"><h2 id="session-settings-title">{t('Admin session')}</h2></div>
        <Button variant="quiet" onClick={() => void onLogout()}><LogOut size={15} aria-hidden="true" /> {t('End local session')}</Button>
      </section>
    ) : null}
  </>;
}
