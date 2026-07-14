import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, KeyRound, RefreshCw, Server, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type {
  CliAvailability,
  CliAvailabilityResponse,
  CreatedCredentialResponse,
  SettingsResponse,
  SetupStatusResponse,
} from '../api/types.js';
import { useI18n } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { Button } from '../components/button.js';
import { SecretField } from '../components/secret-field.js';
import { Toggle } from '../components/toggle.js';

interface TargetSuggestion {
  id: string;
  cli: string;
  label: string;
  nativeModel: string;
  effort: string | null;
  availability: CliAvailability;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function suggestionsFor(entries: CliAvailability[]): TargetSuggestion[] {
  return entries.flatMap((availability) => {
    const { cli, capabilities } = availability;
    if (!capabilities.available || !capabilities.modelOptions) return [];
    if (cli === 'claude') {
      const option = capabilities.modelOptions.find((candidate) => candidate.id === 'default');
      return option ? [{ id: 'claude-default-max', cli, label: `${option.label} / max`, nativeModel: 'default', effort: 'max', availability }] : [];
    }
    if (cli !== 'codex' && cli !== 'cursor' && cli !== 'opencode' && cli !== 'antigravity') return [];
    return capabilities.modelOptions.map((option) => {
      const effort = cli === 'codex'
        ? option.effortOptions?.includes('max') ? 'max' : option.effortOptions?.at(-1) ?? null
        : null;
      const nativeModel = cli === 'antigravity' ? option.label : option.id;
      return {
        id: slug([cli, nativeModel, effort].filter(Boolean).join('-')),
        cli,
        label: effort ? `${option.label} / ${effort}` : option.label,
        nativeModel,
        effort,
        availability,
      };
    });
  });
}

async function refreshStatus(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['setup-status'] });
}

export function SetupPage() {
  const { t } = useI18n();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => adminFetch<SettingsResponse>('/admin/settings') });
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => adminFetch<SetupStatusResponse>('/admin/setup/status') });
  const availability = useQuery({
    queryKey: ['cli-availability'],
    queryFn: () => adminFetch<CliAvailabilityResponse>('/admin/cli-availability'),
    enabled: status.data?.cli_scan_complete === true,
  });
  const [coreUrl, setCoreUrl] = useState('');
  const [coreSkipped, setCoreSkipped] = useState(false);
  const [coreResult, setCoreResult] = useState<string | null>(null);
  const [checkingCore, setCheckingCore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clientName, setClientName] = useState('');
  const [generated, setGenerated] = useState<(CreatedCredentialResponse & { name: string }) | null>(null);

  useEffect(() => () => setGenerated(null), []);

  useEffect(() => {
    if (settings.data) setCoreUrl(settings.data.core.base_url);
  }, [settings.data]);

  const scan = useMutation({
    mutationFn: () => adminFetch<CliAvailabilityResponse>('/admin/cli-availability/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }),
    onSuccess: async (data) => {
      queryClient.setQueryData(['cli-availability'], data);
      await refreshStatus();
    },
  });
  const suggestions = useMemo(() => suggestionsFor(availability.data?.cli_availability ?? []), [availability.data]);
  const createTargets = useMutation({
    mutationFn: async () => {
      const chosen = suggestions.filter((suggestion) => selected.has(suggestion.id));
      await Promise.all(chosen.map((suggestion) => adminFetch('/admin/targets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: suggestion.id,
          aliases: [],
          cli: suggestion.cli,
          native_model: suggestion.nativeModel,
          reasoning_effort: suggestion.effort,
          isolation_level: suggestion.availability.capabilities.isolationLevel,
          streaming_mode: suggestion.availability.capabilities.streamingMode,
          tool_bridge: suggestion.availability.capabilities.toolBridge,
          max_concurrency: 1,
          max_queue: 8,
          queue_timeout_ms: 300000,
          run_timeout_ms: null,
        }),
      })));
    },
    onSuccess: async () => { setSelected(new Set()); await refreshStatus(); },
  });
  const createClient = useMutation({
    mutationFn: async () => {
      const credential = await adminFetch<CreatedCredentialResponse>('/admin/setup/client-credential', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: clientName }),
      });
      setGenerated({ ...credential, name: clientName });
    },
    onSuccess: refreshStatus,
  });

  const checkCore = async () => {
    setCheckingCore(true);
    setCoreResult(null);
    try {
      await adminFetch('/admin/settings/core', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ base_url: coreUrl }),
      });
      try {
        await adminFetch('/admin/core/health');
        setCoreResult('Core is online');
      } catch {
        setCoreResult('Core is offline; setup can continue');
      }
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await refreshStatus();
    } catch {
      setCoreResult('Core URL must be a loopback HTTP URL');
    } finally {
      setCheckingCore(false);
    }
  };

  const progress = status.data;
  const scanComplete = progress?.cli_scan_complete ?? false;
  const installed = (availability.data?.cli_availability ?? []).filter((entry) => entry.capabilities.available);
  const credentialComplete = (progress?.credential_count ?? 0) > 0 || generated !== null;

  return <>
    <div className="page-heading"><div><h1>{t('Gateway setup')}</h1><p>{t('Local connections, targets, and client access')}</p></div></div>
    <div className="setup-steps">
      <section className="setup-step" aria-labelledby="setup-core-title">
        <div className="setup-step__index"><Server size={16} aria-hidden="true" /></div>
        <div className="setup-step__body">
          <div className="section-heading"><h2 id="setup-core-title">{t('1. Core connection')}</h2><span>{t(progress?.core_configured || coreSkipped ? 'Complete' : 'Optional')}</span></div>
          <div className="setup-inline"><label className="field"><span>{t('Core URL')}</span><input value={coreUrl} onChange={(event) => setCoreUrl(event.target.value)} /></label><Button disabled={!coreUrl || checkingCore} onClick={() => void checkCore()}>{t('Check Core')}</Button><Button variant="quiet" onClick={() => setCoreSkipped(true)}>{t('Skip Core')}</Button></div>
          {coreResult ? <p role="status" className={coreResult === 'Core URL must be a loopback HTTP URL' ? 'dialog-error' : 'muted'}>{t(coreResult)}</p> : null}
        </div>
      </section>
      <section className="setup-step" aria-labelledby="setup-cli-title">
        <div className="setup-step__index"><TerminalSquare size={16} aria-hidden="true" /></div>
        <div className="setup-step__body">
          <div className="section-heading"><h2 id="setup-cli-title">{t('2. CLI static scan')}</h2><span>{t(scanComplete ? 'Complete' : 'Pending')}</span></div>
          <div className="setup-actions"><Button disabled={scan.isPending} onClick={() => scan.mutate()}><RefreshCw size={15} aria-hidden="true" /> {t(scanComplete ? 'Refresh CLIs' : 'Scan CLIs')}</Button><span>{t('No model usage')}</span></div>
          {scanComplete && installed.length === 0 ? <p role="status" className="muted">{t('No installed CLIs found')}</p> : null}
        </div>
      </section>
      <section className="setup-step" aria-labelledby="setup-targets-title">
        <div className="setup-step__index"><Check size={16} aria-hidden="true" /></div>
        <div className="setup-step__body">
          <div className="section-heading"><h2 id="setup-targets-title">{t('3. Invocation Targets')}</h2><span>{t('{count} created', { count: progress?.target_count ?? 0 })}</span></div>
          {suggestions.length > 0 ? <div className="suggestion-list">{suggestions.map((suggestion) => <Toggle className="suggestion-row" key={suggestion.id} label={t('Select {id}', { id: suggestion.id })} checked={selected.has(suggestion.id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(suggestion.id); else next.delete(suggestion.id); return next; })}><strong>{suggestion.id}</strong><small>{suggestion.cli} / {suggestion.label}</small></Toggle>)}</div> : <p className="muted">{t(scanComplete ? 'No target suggestions' : 'Scan CLIs to load suggestions')}</p>}
          {suggestions.length > 0 ? <Button disabled={selected.size === 0 || createTargets.isPending} onClick={() => createTargets.mutate()}>{t('Create selected targets')}</Button> : null}
        </div>
      </section>
      <section className="setup-step" aria-labelledby="setup-client-title">
        <div className="setup-step__index"><KeyRound size={16} aria-hidden="true" /></div>
        <div className="setup-step__body">
          <div className="section-heading"><h2 id="setup-client-title">{t('4. Client and key')}</h2><span>{t(credentialComplete ? 'Complete' : 'Required')}</span></div>
          <div className="setup-inline"><label className="field"><span>{t('Client name')}</span><input value={clientName} onChange={(event) => setClientName(event.target.value)} /></label><Button disabled={!clientName.trim() || createClient.isPending} onClick={() => createClient.mutate()}>{t('Create client and key')}</Button></div>
          {generated ? <SecretField label={generated.name} prefix={generated.prefix} initialSecret={generated.api_key} reveal={async () => (await adminFetch<{ api_key: string }>(`/admin/credentials/${encodeURIComponent(generated.id)}/reveal`)).api_key} /> : credentialComplete ? <p className="muted">{t('Existing keys remain revealable under Clients and Keys')}</p> : null}
        </div>
      </section>
    </div>
    <div className="setup-finish"><Button disabled={!credentialComplete} onClick={() => { window.location.hash = '#/overview'; }}>{t('Finish setup')}</Button></div>
  </>;
}
