import { useMutation, useQuery } from '@tanstack/react-query';
import { FlaskConical, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type {
  InvocationTarget,
  CliAvailability,
  CliAvailabilityResponse,
  IsolationLevel,
  StreamingMode,
  TargetsResponse,
  ToolBridge,
} from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { Button, IconButton } from '../components/button.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Dialog } from '../components/dialog.js';
import { Field } from '../components/field.js';
import { Toggle } from '../components/toggle.js';

const targetIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const customChoice = '__custom__';

const cliLabels: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  cursor: 'Cursor Agent',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  kimi: 'Kimi Code',
};

const maxConcurrencyPresets: NumberPreset[] = [
  { value: '1', label: '1 request' },
  { value: '2', label: '2 requests' },
  { value: '4', label: '4 requests' },
];
const maxQueuePresets: NumberPreset[] = [
  { value: '0', label: 'No queue' },
  { value: '4', label: '4 requests' },
  { value: '8', label: '8 requests' },
  { value: '16', label: '16 requests' },
  { value: '32', label: '32 requests' },
];
const queueTimeoutPresets: NumberPreset[] = [
  { value: '30000', label: '30 seconds' },
  { value: '60000', label: '1 minute' },
  { value: '300000', label: '5 minutes' },
  { value: '600000', label: '10 minutes' },
];
const runTimeoutPresets: NumberPreset[] = [
  { value: '', label: 'No timeout' },
  { value: '300000', label: '5 minutes' },
  { value: '1200000', label: '20 minutes' },
  { value: '3600000', label: '1 hour' },
];

interface ModelChoice {
  value: string;
  label: string;
  effortOptions: string[];
}

interface NumberPreset {
  value: string;
  label: string;
}

interface TargetFormState {
  id: string;
  aliases: string;
  cli: string;
  nativeModel: string;
  reasoningEffort: string;
  enabled: boolean;
  isolationLevel: IsolationLevel;
  streamingMode: StreamingMode;
  toolBridge: ToolBridge;
  maxConcurrency: string;
  maxQueue: string;
  queueTimeoutMs: string;
  runTimeoutMs: string;
  fixedWorkspace: string;
  acknowledgeFixedWorkspaceDowngrade: boolean;
}

function availabilityFor(availability: CliAvailability[], cli: string): CliAvailability | undefined {
  return availability.find((entry) => entry.cli === cli);
}

function modelChoicesFor(availability: CliAvailability[], cli: string): ModelChoice[] {
  const options = availabilityFor(availability, cli)?.capabilities.modelOptions ?? [];
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const value = cli === 'antigravity' ? option.label : option.id;
    if (seen.has(value)) return [];
    seen.add(value);
    return [{ value, label: option.label, effortOptions: option.effortOptions ?? [] }];
  });
}

function preferredEffort(options: string[]): string {
  return options.includes('max') ? 'max' : options.at(-1) ?? '';
}

function initialCli(availability: CliAvailability[]): string {
  if (availabilityFor(availability, 'codex')?.capabilities.available) return 'codex';
  return availability.find((entry) => entry.capabilities.available && entry.cli in cliLabels)?.cli ?? 'codex';
}

function stateFor(target: InvocationTarget | null, availability: CliAvailability[]): TargetFormState {
  return target ? {
    id: target.id,
    aliases: target.aliases.join(', '),
    cli: target.cli,
    nativeModel: target.nativeModel,
    reasoningEffort: target.reasoningEffort ?? '',
    enabled: target.enabled,
    isolationLevel: target.isolationLevel,
    streamingMode: target.streamingMode,
    toolBridge: target.toolBridge,
    maxConcurrency: String(target.maxConcurrency),
    maxQueue: String(target.maxQueue),
    queueTimeoutMs: String(target.queueTimeoutMs),
    runTimeoutMs: target.runTimeoutMs === null ? '' : String(target.runTimeoutMs),
    fixedWorkspace: target.fixedWorkspace ?? '',
    acknowledgeFixedWorkspaceDowngrade: false,
  } : (() => {
    const cli = initialCli(availability);
    const scanned = availabilityFor(availability, cli);
    const model = modelChoicesFor(availability, cli)[0];
    const reasoningEffort = preferredEffort(model?.effortOptions ?? []);
    return {
      id: model ? proposal(cli, model.value, reasoningEffort) : '',
      aliases: '',
      cli,
      nativeModel: model?.value ?? '',
      reasoningEffort,
      enabled: false,
      isolationLevel: scanned?.capabilities.isolationLevel ?? 'strict',
      streamingMode: scanned?.capabilities.streamingMode ?? 'native',
      toolBridge: scanned?.capabilities.toolBridge ?? 'structured_output',
      maxConcurrency: '1',
      maxQueue: '8',
      queueTimeoutMs: '300000',
      runTimeoutMs: '',
      fixedWorkspace: '',
      acknowledgeFixedWorkspaceDowngrade: false,
    };
  })();
}

function aliasesFrom(value: string): string[] {
  return value.split(/[\n,]/).map((alias) => alias.trim()).filter(Boolean);
}

function proposal(cli: string, model: string, effort: string): string {
  const modelShort = model.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return [cli.toLowerCase(), modelShort, effort.toLowerCase()].filter(Boolean).join('-');
}

function proposedId(form: Pick<TargetFormState, 'cli' | 'nativeModel' | 'reasoningEffort'>): string {
  return form.nativeModel.trim() ? proposal(form.cli, form.nativeModel, form.reasoningEffort) : '';
}

function positiveInteger(value: string): boolean {
  return Number(value) > 0 && Number.isInteger(Number(value));
}

function nonNegativeInteger(value: string): boolean {
  return Number(value) >= 0 && Number.isInteger(Number(value));
}

function PresetNumberField({
  label,
  value,
  presets,
  min,
  onChange,
}: {
  label: string;
  value: string;
  presets: NumberPreset[];
  min: number;
  onChange(value: string): void;
}) {
  const { t } = useI18n();
  const matchesPreset = presets.some((preset) => preset.value === value);
  const [customSelected, setCustomSelected] = useState(!matchesPreset);
  const custom = customSelected || !matchesPreset;

  return <>
    <Field label={t(label)}>
      <select value={custom ? customChoice : value} onChange={(event) => {
        if (event.target.value === customChoice) {
          setCustomSelected(true);
          onChange('');
        } else {
          setCustomSelected(false);
          onChange(event.target.value);
        }
      }}>
        {presets.map((preset) => <option key={preset.value || 'none'} value={preset.value}>{t(preset.label)}</option>)}
        <option value={customChoice}>{t('Custom...')}</option>
      </select>
    </Field>
    {custom ? <Field label={t('Custom {label}', { label: t(label).toLocaleLowerCase() })} requirement="required">
      <input type="number" min={min} step="1" required value={value} onChange={(event) => onChange(event.target.value)} />
    </Field> : null}
  </>;
}

function compatible(target: InvocationTarget, availability?: CliAvailability): boolean {
  const capability = target.capabilities;
  if (!target.capabilityVersion || !target.capabilityVerifiedAt || target.capabilityError || !capability
    || !availability?.capabilities.available
    || availability.capabilities.version !== target.capabilityVersion) return false;
  return (target.isolationLevel !== 'strict' || capability.isolationLevel === 'strict')
    && (target.streamingMode === 'none' || capability.streamingMode === 'native')
    && (target.toolBridge === 'none' || capability.toolBridge === 'structured_output')
    && capability.modelSelection
    && (target.reasoningEffort === null || capability.effortSelection);
}

function capabilityState(target: InvocationTarget, key: 'streamingMode' | 'toolBridge', t: Translate): string {
  if (!target.capabilities) return t('Unverified');
  if (target.capabilityError) return t('Unavailable');
  return target.capabilities[key] === 'none' ? t('Unsupported') : t('Supported');
}

function capabilityIssue(error: string, t: Translate): string {
  if (error === 'conformance_required') return t('Verification required');
  if (error === 'configuration_changed') return t('Configuration changed; verify again');
  const words = error.replaceAll('_', ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function TargetEditor({
  target,
  availability,
  onClose,
}: {
  target: InvocationTarget | null;
  availability: CliAvailability[];
  onClose(): void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState(() => stateFor(target, availability));
  const [idEdited, setIdEdited] = useState(target !== null);
  const [forceCustomModel, setForceCustomModel] = useState(false);
  const [forceCustomEffort, setForceCustomEffort] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'managed' | 'fixed'>(target?.fixedWorkspace ? 'fixed' : 'managed');
  const [saveAttempted, setSaveAttempted] = useState(false);
  const initializedFromScan = useRef(target !== null || form.nativeModel.length > 0);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (target !== null || initializedFromScan.current || availability.length === 0) return;
    initializedFromScan.current = true;
    setForm((current) => current.nativeModel ? current : stateFor(null, availability));
  }, [availability, target]);

  const aliases = aliasesFrom(form.aliases);
  const fixedWorkspace = workspaceMode === 'fixed' ? form.fixedWorkspace.trim() : '';
  const runTimeoutMs = form.runTimeoutMs.trim();
  const modelChoices = modelChoicesFor(availability, form.cli);
  const selectedModel = modelChoices.find((choice) => choice.value === form.nativeModel);
  const customModel = forceCustomModel || modelChoices.length === 0
    || (form.nativeModel.length > 0 && selectedModel === undefined);
  const effortOptions = selectedModel?.effortOptions ?? [];
  const customEffort = forceCustomEffort || (form.reasoningEffort.length > 0
    && !effortOptions.includes(form.reasoningEffort));
  const identifiersValid = targetIdPattern.test(form.id)
    && aliases.every((alias) => alias !== form.id)
    && new Set(aliases).size === aliases.length;
  const validationErrors: string[] = [];
  if (!form.nativeModel.trim()) validationErrors.push('Select a native model or enter a custom model.');
  if (!targetIdPattern.test(form.id)) validationErrors.push('Enter a canonical ID using lowercase letters, numbers, dots, underscores, or hyphens.');
  else if (!identifiersValid) validationErrors.push('Aliases must be unique and different from the canonical ID.');
  if (forceCustomEffort && !form.reasoningEffort.trim()) validationErrors.push('Enter a custom reasoning effort or select Provider default.');
  if (!positiveInteger(form.maxConcurrency)) validationErrors.push('Max concurrency must be a positive whole number.');
  if (!nonNegativeInteger(form.maxQueue)) validationErrors.push('Max queue must be zero or a positive whole number.');
  if (!positiveInteger(form.queueTimeoutMs)) validationErrors.push('Queue timeout must be a positive whole number of milliseconds.');
  if (runTimeoutMs !== '' && !positiveInteger(runTimeoutMs)) validationErrors.push('Run timeout must be blank or a positive whole number of milliseconds.');
  if (workspaceMode === 'fixed' && fixedWorkspace.length === 0) validationErrors.push('Enter an absolute fixed workspace path.');
  if (workspaceMode === 'fixed' && !form.acknowledgeFixedWorkspaceDowngrade) validationErrors.push('Acknowledge the fixed-workspace isolation downgrade.');
  const valid = validationErrors.length === 0;
  const save = useMutation({
    mutationFn: () => adminFetch<InvocationTarget>(
      target ? `/admin/targets/${encodeURIComponent(target.id)}` : '/admin/targets',
      {
        method: target ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(target ? {} : { id: form.id }),
          aliases,
          cli: form.cli,
          native_model: form.nativeModel.trim(),
          reasoning_effort: form.reasoningEffort.trim() || null,
          ...(target ? { enabled: form.enabled } : {}),
          isolation_level: workspaceMode === 'fixed' ? 'best_effort' : form.isolationLevel,
          streaming_mode: form.streamingMode,
          tool_bridge: form.toolBridge,
          max_concurrency: Number(form.maxConcurrency),
          max_queue: Number(form.maxQueue),
          queue_timeout_ms: Number(form.queueTimeoutMs),
          run_timeout_ms: runTimeoutMs === '' ? null : Number(runTimeoutMs),
          fixed_workspace: workspaceMode === 'fixed' ? fixedWorkspace : null,
          acknowledge_fixed_workspace_downgrade: form.acknowledgeFixedWorkspaceDowngrade,
          ...(target ? {} : { verify_on_create: true, confirm_model_usage: true }),
        }),
      },
    ),
    onSuccess: async () => {
      onClose();
      await queryClient.invalidateQueries({ queryKey: ['targets'] });
      await queryClient.invalidateQueries({ queryKey: ['cli-availability'] });
    },
  });
  const set = <Key extends keyof TargetFormState>(key: Key, value: TargetFormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };
  const setIdentity = (patch: Partial<Pick<TargetFormState, 'cli' | 'nativeModel' | 'reasoningEffort'>>) => {
    setForm((current) => {
      const next = { ...current, ...patch };
      return idEdited ? next : { ...next, id: proposedId(next) };
    });
  };
  const selectCli = (cli: string) => {
    const scanned = availabilityFor(availability, cli);
    const model = modelChoicesFor(availability, cli)[0];
    const reasoningEffort = preferredEffort(model?.effortOptions ?? []);
    setForceCustomModel(false);
    setForceCustomEffort(false);
    setForm((current) => {
      const next = {
        ...current,
        cli,
        nativeModel: model?.value ?? '',
        reasoningEffort,
        isolationLevel: scanned?.capabilities.isolationLevel ?? current.isolationLevel,
        streamingMode: scanned?.capabilities.streamingMode ?? current.streamingMode,
        toolBridge: scanned?.capabilities.toolBridge ?? current.toolBridge,
      };
      return idEdited ? next : { ...next, id: proposedId(next) };
    });
  };
  const selectModel = (value: string) => {
    if (value === customChoice) {
      setForceCustomModel(true);
      setForceCustomEffort(false);
      setIdentity({ nativeModel: '', reasoningEffort: '' });
      return;
    }
    const model = modelChoices.find((choice) => choice.value === value);
    setForceCustomModel(false);
    setForceCustomEffort(false);
    setIdentity({ nativeModel: value, reasoningEffort: preferredEffort(model?.effortOptions ?? []) });
  };
  const selectEffort = (value: string) => {
    if (value === customChoice) {
      setForceCustomEffort(true);
      setIdentity({ reasoningEffort: '' });
      return;
    }
    setForceCustomEffort(false);
    setIdentity({ reasoningEffort: value });
  };
  const submit = () => {
    setSaveAttempted(true);
    if (valid) save.mutate();
  };

  return (
    <Dialog
      title={t(target ? 'Edit target' : 'Create target')}
      onClose={onClose}
      initialFocusRef={cancelRef}
      wide
      actions={(
        <>
          <Button ref={cancelRef} variant="quiet" onClick={onClose}>{t('Cancel')}</Button>
          <Button aria-busy={save.isPending || undefined} disabled={save.isPending} onClick={submit}>
            {t(target ? 'Save target' : save.isPending ? 'Creating and verifying...' : 'Create and verify')}
          </Button>
        </>
      )}
    >
      <div className="target-form">
        <Field label={t('Canonical ID')} requirement="required" hint={!identifiersValid ? t('Use lowercase letters, numbers, dots, underscores, or hyphens; aliases must be unique.') : undefined}>
          <input value={form.id} readOnly={target !== null} required pattern="[a-z0-9][a-z0-9._-]*" onChange={(event) => { setIdEdited(true); set('id', event.target.value); }} />
        </Field>
        <Field label={t('Aliases')} requirement="optional"><input value={form.aliases} onChange={(event) => set('aliases', event.target.value)} placeholder={t('Comma separated')} /></Field>
        <Field label="CLI" requirement="required" hint={!availabilityFor(availability, form.cli)?.capabilities.available ? t('This CLI was not found by the latest scan.') : undefined}>
          <select required value={form.cli} onChange={(event) => selectCli(event.target.value)}>
            {Object.entries(cliLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={t('Native model')} requirement="required" hint={modelChoices.length === 0 ? t('No models were returned by the latest CLI scan.') : undefined}>
          <select required value={customModel ? customChoice : form.nativeModel} onChange={(event) => selectModel(event.target.value)}>
            {modelChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            <option value={customChoice}>{t('Custom...')}</option>
          </select>
        </Field>
        {customModel ? <Field label={t('Custom native model')} requirement="required">
          <input required value={form.nativeModel} onChange={(event) => setIdentity({ nativeModel: event.target.value })} />
        </Field> : null}
        <Field label={t('Reasoning effort')} requirement="optional">
          <select value={customEffort ? customChoice : form.reasoningEffort} onChange={(event) => selectEffort(event.target.value)}>
            <option value="">{t('Provider default')}</option>
            {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            <option value={customChoice}>{t('Custom...')}</option>
          </select>
        </Field>
        {customEffort ? <Field label={t('Custom reasoning effort')} requirement="required">
          <input required value={form.reasoningEffort} onChange={(event) => setIdentity({ reasoningEffort: event.target.value })} />
        </Field> : null}
        <Field label={t('Isolation')}>
          <select value={workspaceMode === 'fixed' ? 'best_effort' : form.isolationLevel} disabled={workspaceMode === 'fixed'} onChange={(event) => set('isolationLevel', event.target.value as IsolationLevel)}>
            <option value="strict">{t('Strict')}</option><option value="best_effort">{t('Best effort')}</option>
          </select>
        </Field>
        <Field label={t('Streaming')}><select value={form.streamingMode} onChange={(event) => set('streamingMode', event.target.value as StreamingMode)}><option value="native">{t('Native')}</option><option value="none">{t('None')}</option></select></Field>
        <Field label={t('Tool mode')}><select value={form.toolBridge} onChange={(event) => set('toolBridge', event.target.value as ToolBridge)}><option value="structured_output">{t('Structured output')}</option><option value="none">{t('None')}</option></select></Field>
        <PresetNumberField label="Max concurrency" value={form.maxConcurrency} presets={maxConcurrencyPresets} min={1} onChange={(value) => set('maxConcurrency', value)} />
        <PresetNumberField label="Max queue" value={form.maxQueue} presets={maxQueuePresets} min={0} onChange={(value) => set('maxQueue', value)} />
        <PresetNumberField label="Queue timeout" value={form.queueTimeoutMs} presets={queueTimeoutPresets} min={1} onChange={(value) => set('queueTimeoutMs', value)} />
        <PresetNumberField label="Run timeout" value={form.runTimeoutMs} presets={runTimeoutPresets} min={1} onChange={(value) => set('runTimeoutMs', value)} />
        <Field label={t('Workspace')}>
          <select value={workspaceMode} onChange={(event) => {
            const mode = event.target.value as 'managed' | 'fixed';
            setWorkspaceMode(mode);
            setForm((current) => ({
              ...current,
              fixedWorkspace: mode === 'managed' ? '' : current.fixedWorkspace,
              isolationLevel: mode === 'fixed' ? 'best_effort' : current.isolationLevel,
              acknowledgeFixedWorkspaceDowngrade: false,
            }));
          }}>
            <option value="managed">{t('Gateway managed')}</option>
            <option value="fixed">{t('Fixed path...')}</option>
          </select>
        </Field>
        {workspaceMode === 'fixed' ? <Field label={t('Fixed workspace path')} requirement="required">
          <input required value={form.fixedWorkspace} onChange={(event) => set('fixedWorkspace', event.target.value)} placeholder="/absolute/path/to/project" />
        </Field> : null}
      </div>
      {workspaceMode === 'fixed' ? <div className="acknowledgements">
        <Toggle label={t('Acknowledge workspace isolation downgrade')} showLabel required checked={form.acknowledgeFixedWorkspaceDowngrade} onCheckedChange={(checked) => set('acknowledgeFixedWorkspaceDowngrade', checked)} />
      </div> : null}
      {target === null ? <p className="muted">{t('Creating this target runs bounded model requests and may consume quota.')}</p> : null}
      {save.isPending && target === null ? <div className="verification-status" role="status" aria-live="polite"><LoaderCircle className="icon-spin" size={18} aria-hidden="true" /><span><strong>{t('Creating and verifying target')}</strong><small>{t('Running provider conformance checks. This can take several minutes.')}</small></span></div> : null}
      {!valid ? <p className={saveAttempted ? 'dialog-error target-validation' : 'muted target-validation'} role={saveAttempted ? 'alert' : 'status'}>{t(validationErrors[0]!)}</p> : null}
      {save.isError ? <p className="dialog-error">{t(target ? 'Target could not be saved.' : 'Target could not be created or verified.')}</p> : null}
    </Dialog>
  );
}

export function TargetsPage() {
  const { t } = useI18n();
  const [verifyCandidate, setVerifyCandidate] = useState<InvocationTarget | null>(null);
  const [editorTarget, setEditorTarget] = useState<InvocationTarget | null | undefined>(undefined);
  const [deleteCandidate, setDeleteCandidate] = useState<InvocationTarget | null>(null);
  const [enableCandidate, setEnableCandidate] = useState<InvocationTarget | null>(null);
  const [enableAcknowledged, setEnableAcknowledged] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => adminFetch<TargetsResponse>('/admin/targets') });
  const availability = useQuery({
    queryKey: ['cli-availability'],
    queryFn: () => adminFetch<CliAvailabilityResponse>('/admin/cli-availability'),
  });
  const availabilityByCli = new Map(
    (availability.data?.cli_availability ?? []).map((item) => [item.cli, item]),
  );
  const refreshTargets = () => queryClient.invalidateQueries({ queryKey: ['targets'] });
  const verify = useMutation({
    mutationFn: (id: string) => adminFetch(`/admin/targets/${encodeURIComponent(id)}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm_model_usage: true }) }),
    onSuccess: async () => { setVerifyCandidate(null); await refreshTargets(); },
  });
  const openVerifyDialog = (target: InvocationTarget) => {
    verify.reset();
    setVerifyCandidate(target);
  };
  const closeVerifyDialog = () => {
    setVerifyCandidate(null);
    if (!verify.isPending) verify.reset();
  };
  const toggle = useMutation({
    mutationFn: ({ target, enabled }: { target: InvocationTarget; enabled: boolean }) => adminFetch(`/admin/targets/${encodeURIComponent(target.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, enabled_best_effort: enabled && target.isolationLevel === 'best_effort' }),
    }),
    onSuccess: async () => { setEnableCandidate(null); await refreshTargets(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => adminFetch(`/admin/targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => { setDeleteCandidate(null); await refreshTargets(); },
  });

  const columns: Array<DataTableColumn<InvocationTarget>> = [
    { key: 'id', label: 'ID', width: '176px', render: (item) => item.id },
    { key: 'cli', label: 'CLI', width: '92px', render: (item) => item.cli },
    { key: 'model', label: t('Native Model'), width: '132px', render: (item) => item.nativeModel },
    { key: 'effort', label: t('Effort'), width: '82px', render: (item) => item.reasoningEffort ?? '-' },
    { key: 'isolation', label: t('Isolation'), width: '104px', render: (item) => item.isolationLevel },
    { key: 'streaming', label: t('Streaming'), width: '110px', render: (item) => capabilityState(item, 'streamingMode', t) },
    { key: 'tools', label: t('Tools'), width: '110px', render: (item) => capabilityState(item, 'toolBridge', t) },
    { key: 'version', label: t('Static / Verified'), width: '150px', render: (item) => {
      const current = availabilityByCli.get(item.cli);
      const staticVersion = current?.capabilities.version ?? '-';
      const verifiedVersion = item.capabilityVerifiedAt ? (item.capabilityVersion ?? '-') : '-';
      const mismatch = staticVersion !== '-' && verifiedVersion !== '-' && staticVersion !== verifiedVersion;
      return <div>
        {staticVersion} / {verifiedVersion}
        {mismatch ? <div>{t('Version mismatch')}</div> : null}
        {item.capabilityError ? <div title={item.capabilityError}>{capabilityIssue(item.capabilityError, t)}</div> : null}
        {current?.capabilities.error ? <div title={current.capabilities.error}>{capabilityIssue(current.capabilities.error, t)}</div> : null}
      </div>;
    } },
    { key: 'queue', label: t('Queue'), width: '82px', render: (item) => `${item.maxConcurrency}/${item.maxQueue}` },
    { key: 'enabled', label: t('Enabled'), width: '78px', render: (item) => <Toggle label={t('Enable {id}', { id: item.id })} checked={item.enabled} disabled={toggle.isPending || (!item.enabled && !compatible(item, availabilityByCli.get(item.cli)))} onCheckedChange={(enabled) => { if (enabled && item.isolationLevel === 'best_effort') { setEnableAcknowledged(false); setEnableCandidate(item); } else toggle.mutate({ target: item, enabled }); }} /> },
    { key: 'actions', label: t('Actions'), width: '184px', className: 'actions-cell', render: (item) => {
      const verifying = verify.isPending && verify.variables === item.id;
      return <div className="table-actions"><Button variant="quiet" aria-label={t('{action} {id}', { action: t(verifying ? 'Verifying' : 'Verify'), id: item.id })} aria-busy={verifying || undefined} disabled={verify.isPending} onClick={() => openVerifyDialog(item)}>{verifying ? <LoaderCircle className="icon-spin" size={15} aria-hidden="true" /> : <FlaskConical size={15} aria-hidden="true" />} {t(verifying ? 'Verifying' : 'Verify')}</Button><IconButton label={t('Edit {id}', { id: item.id })} variant="quiet" onClick={() => setEditorTarget(item)}><Pencil size={15} aria-hidden="true" /></IconButton><IconButton label={t('Delete {id}', { id: item.id })} variant="quiet" disabled={item.enabled} onClick={() => setDeleteCandidate(item)}><Trash2 size={15} aria-hidden="true" /></IconButton></div>;
    } },
  ];

  return <>
    <div className="page-heading"><div><h1>{t('Invocation Targets')}</h1><p>{t('Gateway provider configurations and verified capabilities')}</p></div><Button onClick={() => setEditorTarget(null)}><Plus size={16} aria-hidden="true" /> {t('Create target')}</Button></div>
    {verify.isPending && !verifyCandidate ? <p className="operation-status" role="status"><LoaderCircle className="icon-spin" size={16} aria-hidden="true" /> {t('Verifying target')} <strong>{verify.variables}</strong></p> : null}
    {verify.isError && !verifyCandidate ? <p className="dialog-error" role="alert">{t('Verification failed for')} <strong>{verify.variables}</strong></p> : null}
    <section className="table-section" aria-label={t('Invocation targets')}><DataTable ariaLabel={t('Invocation Targets')} columns={columns} rows={targets.data?.targets ?? []} rowKey={(item) => item.id} emptyTitle={targets.isError ? t('Targets unavailable') : t('No invocation targets')} /></section>
    {editorTarget !== undefined ? <TargetEditor target={editorTarget} availability={availability.data?.cli_availability ?? []} onClose={() => setEditorTarget(undefined)} /> : null}
    {verifyCandidate ? <Dialog title={t('Verify target')} onClose={closeVerifyDialog} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={closeVerifyDialog}>{t(verify.isPending ? 'Hide' : 'Cancel')}</Button><Button aria-busy={verify.isPending || undefined} disabled={verify.isPending} onClick={() => verify.mutate(verifyCandidate.id)}><FlaskConical size={16} aria-hidden="true" /> {t(verify.isPending ? 'Verifying...' : 'Verify target')}</Button></>}><p>{t("This runs bounded model requests and may consume quota. Verification applies to this target's model and execution settings.")}</p>{verify.isPending ? <div className="verification-status" role="status" aria-live="polite"><LoaderCircle className="icon-spin" size={18} aria-hidden="true" /><span><strong>{t('Verification in progress')}</strong><small>{t('Running provider conformance checks. This can take several minutes.')}</small></span></div> : null}{verify.isError ? <p className="dialog-error" role="alert">{t('Verification failed')}</p> : null}</Dialog> : null}
    {enableCandidate ? <Dialog title={t('Enable target')} onClose={() => setEnableCandidate(null)} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={() => setEnableCandidate(null)}>{t('Cancel')}</Button><Button disabled={!enableAcknowledged || toggle.isPending} onClick={() => toggle.mutate({ target: enableCandidate, enabled: true })}>{t('Enable target')}</Button></>}><p>{t('This target provides best-effort rather than strict workspace isolation.')}</p><Toggle className="dialog-toggle" label={t('Allow best-effort isolation')} showLabel required checked={enableAcknowledged} onCheckedChange={setEnableAcknowledged} /></Dialog> : null}
    {deleteCandidate ? <Dialog title={t('Delete target')} onClose={() => setDeleteCandidate(null)} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={() => setDeleteCandidate(null)}>{t('Cancel')}</Button><Button variant="danger" onClick={() => remove.mutate(deleteCandidate.id)}>{t('Delete target')}</Button></>}><p>{t('Delete target {id}? Historical run metadata is retained.', { id: deleteCandidate.id })}</p></Dialog> : null}
  </>;
}
