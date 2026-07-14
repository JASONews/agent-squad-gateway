import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { adminFetch } from '../api/client.js';
import type {
  ClientDetailResponse,
  ClientsResponse,
  CredentialMetadata,
  ExtensionsResponse,
  InvocationTarget,
  TargetsResponse,
} from '../api/types.js';
import { useI18n, type Translate } from '../app/i18n.js';
import { queryClient } from '../app/query-client.js';
import { Button, IconButton } from '../components/button.js';
import { DataTable, type DataTableColumn } from '../components/data-table.js';
import { Dialog } from '../components/dialog.js';
import { SecretField } from '../components/secret-field.js';
import { Toggle } from '../components/toggle.js';

const extensionNames: Record<string, string> = { openai: 'OpenAI' };
const refreshKeys = ['clients', 'credentials', 'grants', 'models-preview'] as const;

async function refreshClientData() {
  await Promise.all(refreshKeys.map((key) => queryClient.invalidateQueries({ queryKey: [key], exact: true })));
}

function dateTimeValue(value: string): string | null {
  return value === '' ? null : new Date(value).toISOString();
}

function unavailableReason(target: InvocationTarget, t: Translate): string | null {
  if (!target.enabled && target.capabilityVerifiedAt === null) return t('Target is disabled and unverified');
  if (!target.enabled) return t('Target is disabled');
  if (target.capabilityVerifiedAt === null) return t('Target is unverified');
  if (target.capabilityError) return target.capabilityError;
  return null;
}

function CreateClientDialog({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const create = useMutation({
    mutationFn: () => adminFetch('/admin/clients', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    }),
    onSuccess: async () => { await refreshClientData(); onClose(); },
  });
  return <Dialog title={t('Create client')} onClose={onClose} initialFocusRef={cancelRef} actions={<>
    <Button ref={cancelRef} variant="quiet" onClick={onClose}>{t('Cancel')}</Button>
    <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}><Plus size={15} aria-hidden="true" /> {t('Create client')}</Button>
  </>}>
    <label className="field"><span>{t('Client name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
    {create.isError ? <p className="dialog-error">{t('Client could not be created')}</p> : null}
  </Dialog>;
}

export function ClientsPage({ clientId }: { clientId?: string }) {
  return clientId ? <ClientDetail clientId={clientId} /> : <ClientList />;
}

function ClientList() {
  const { locale, t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<ClientsResponse['clients'][number] | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => adminFetch<ClientsResponse>('/admin/clients') });
  const remove = useMutation({
    mutationFn: (id: string) => adminFetch<void>(`/admin/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: async () => { setDeleteCandidate(null); await refreshClientData(); },
  });
  const columns: Array<DataTableColumn<ClientsResponse['clients'][number]>> = [
    { key: 'name', label: t('Name'), width: '240px', render: (item) => <a href={`#/clients/${encodeURIComponent(item.id)}`}>{item.name}</a> },
    { key: 'status', label: t('Status'), width: '110px', render: (item) => t(item.status) },
    { key: 'credentials', label: t('Credentials'), width: '110px', className: 'numeric', render: (item) => item.credentialCount },
    { key: 'grants', label: t('Grants'), width: '90px', className: 'numeric', render: (item) => item.grantCount },
    { key: 'used', label: t('Last Used'), width: '190px', render: (item) => item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString(locale) : t('Never') },
    { key: 'actions', label: t('Actions'), width: '140px', render: (item) => <div className="table-actions"><Button variant="quiet" onClick={() => { window.location.hash = `#/clients/${encodeURIComponent(item.id)}`; }}>{t('Open')}</Button><IconButton label={t('Delete client {name}', { name: item.name })} variant="quiet" onClick={() => setDeleteCandidate(item)}><Trash2 size={15} aria-hidden="true" /></IconButton></div> },
  ];
  return <>
    <div className="page-heading"><div><h1>{t('Clients and Keys')}</h1><p>{t('API identities, recoverable credentials, and target access')}</p></div><Button onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /> {t('Create client')}</Button></div>
    <section className="table-section"><DataTable ariaLabel={t('Clients')} columns={columns} rows={clients.data?.clients ?? []} rowKey={(item) => item.id} emptyTitle={clients.isError ? t('Clients unavailable') : t('No clients')} /></section>
    {creating ? <CreateClientDialog onClose={() => setCreating(false)} /> : null}
    {deleteCandidate ? <Dialog title={t('Delete client')} onClose={() => setDeleteCandidate(null)} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={() => setDeleteCandidate(null)}>{t('Cancel')}</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(deleteCandidate.id)}>{t('Delete client permanently')}</Button></>}><p>{t('Delete {name}? Credentials and grants will be removed immediately. Historical completed runs are retained.', { name: deleteCandidate.name })}</p>{remove.isError ? <p className="dialog-error">{t('Client could not be deleted')}</p> : null}</Dialog> : null}
  </>;
}

function ClientDetail({ clientId }: { clientId: string }) {
  const { locale, t } = useI18n();
  const [createCredential, setCreateCredential] = useState(false);
  const [revokeCandidate, setRevokeCandidate] = useState<CredentialMetadata | null>(null);
  const [rotateCandidate, setRotateCandidate] = useState<CredentialMetadata | null>(null);
  const [rotationNotice, setRotationNotice] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const detail = useQuery({ queryKey: ['clients', clientId], queryFn: () => adminFetch<ClientDetailResponse>(`/admin/clients/${encodeURIComponent(clientId)}`) });
  const targets = useQuery({ queryKey: ['targets'], queryFn: () => adminFetch<TargetsResponse>('/admin/targets') });
  const extensions = useQuery({ queryKey: ['extensions'], queryFn: () => adminFetch<ExtensionsResponse>('/admin/extensions') });
  const refresh = async () => { await refreshClientData(); await queryClient.invalidateQueries({ queryKey: ['clients', clientId] }); };
  const status = useMutation({
    mutationFn: (next: 'active' | 'disabled') => adminFetch(`/admin/clients/${encodeURIComponent(clientId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: next }) }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => adminFetch<void>(`/admin/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleteConfirmation(false);
      queryClient.removeQueries({ queryKey: ['clients', clientId], exact: true });
      await refreshClientData();
      window.location.hash = '#/clients';
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => adminFetch(`/admin/credentials/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    onSuccess: async () => { setRevokeCandidate(null); await refresh(); },
  });
  const changeGrant = useMutation({
    mutationFn: ({ extensionId, targetId, enabled }: { extensionId: string; targetId: string; enabled: boolean }) => adminFetch('/admin/grants', { method: enabled ? 'POST' : 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, extension_id: extensionId, target_id: targetId }) }),
    onSuccess: refresh,
  });
  const client = detail.data?.client;
  if (!client) return <div className="page-heading"><div><h1>{t('Client')}</h1><p>{detail.isError ? t('Client unavailable') : t('Loading client')}</p></div></div>;

  return <>
    <div className="page-heading"><div><a href="#/clients">{t('Clients and Keys')}</a><h1>{client.name}</h1><p>{client.id}</p></div><div className="table-actions"><Toggle label={t('Client enabled')} showLabel checked={client.status === 'active'} disabled={status.isPending} onCheckedChange={(enabled) => status.mutate(enabled ? 'active' : 'disabled')} /><Button variant="danger" onClick={() => setDeleteConfirmation(true)}><Trash2 size={15} aria-hidden="true" /> {t('Delete client')}</Button></div></div>
    {rotationNotice ? <p role="status" className="operation-notice">{t('Previous key revoked')}</p> : null}
    <section className="client-section" aria-labelledby="credentials-title">
      <div className="section-heading"><h2 id="credentials-title">{t('Credentials')}</h2><Button onClick={() => setCreateCredential(true)}><KeyRound size={15} aria-hidden="true" /> {t('Create credential')}</Button></div>
      <div className="credential-list">
        {(detail.data?.credentials ?? []).map((credential) => {
          const expired = credential.expiresAt !== null && credential.expiresAt <= new Date().toISOString();
          const inactive = credential.revokedAt !== null || expired;
          return <div className="credential-row" key={credential.id}>
            <div><strong>{credential.name}</strong><small>{credential.revokedAt ? t('Revoked') : expired ? t('Expired') : credential.expiresAt ? t('Expires {date}', { date: new Date(credential.expiresAt).toLocaleString(locale) }) : t('No expiry')}</small></div>
            <SecretField label={credential.name} prefix={credential.prefix} reveal={async () => (await adminFetch<{ api_key: string }>(`/admin/credentials/${encodeURIComponent(credential.id)}/reveal`)).api_key} />
            <div className="table-actions"><IconButton label={t('Rotate key {name}', { name: credential.name })} disabled={inactive} variant="quiet" onClick={() => setRotateCandidate(credential)}><RotateCw size={15} aria-hidden="true" /></IconButton><IconButton label={t('Revoke key {name}', { name: credential.name })} disabled={inactive} variant="quiet" onClick={() => setRevokeCandidate(credential)}><Trash2 size={15} aria-hidden="true" /></IconButton></div>
          </div>;
        })}
      </div>
    </section>
    <section className="client-section" aria-labelledby="grants-title">
      <div className="section-heading"><h2 id="grants-title">{t('Extension and target grants')}</h2><span>{t('{count} assigned', { count: detail.data?.grants.length ?? 0 })}</span></div>
      <div className="grant-matrix">
        {(extensions.data?.extensions ?? []).map((extension) => <div className="grant-group" key={extension.id}><h3>{extensionNames[extension.id] ?? extension.id}</h3>{(targets.data?.targets ?? []).map((target) => {
          const reason = extension.enabled ? unavailableReason(target, t) : t('Extension is disabled');
          const checked = detail.data?.grants.some((grant) => grant.extensionId === extension.id && grant.targetId === target.id) ?? false;
          return <Toggle className="grant-row" key={target.id} label={t('Grant {extension} to {target}', { extension: extensionNames[extension.id] ?? extension.id, target: target.id })} checked={checked} disabled={reason !== null || !extension.enabled || changeGrant.isPending} onCheckedChange={(enabled) => changeGrant.mutate({ extensionId: extension.id, targetId: target.id, enabled })}><strong>{target.id}</strong><small>{reason ?? `${target.cli} / ${target.nativeModel}`}</small></Toggle>;
        })}</div>)}
      </div>
    </section>
    {createCredential ? <CredentialDialog title={t('Create credential')} action={t('Create credential')} defaultName={client.name} onClose={() => setCreateCredential(false)} onSubmit={async (name, expiresAt) => { await adminFetch(`/admin/clients/${encodeURIComponent(clientId)}/credentials`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expires_at: expiresAt }) }); await refresh(); setCreateCredential(false); }} /> : null}
    {rotateCandidate ? <CredentialDialog title={t('Rotate credential')} action={t('Rotate and revoke')} defaultName={rotateCandidate.name} onClose={() => setRotateCandidate(null)} onSubmit={async (name, expiresAt) => { await adminFetch(`/admin/credentials/${encodeURIComponent(rotateCandidate.id)}/rotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, expires_at: expiresAt }) }); setRotateCandidate(null); setRotationNotice(true); await refresh(); }} /> : null}
    {revokeCandidate ? <Dialog title={t('Revoke credential')} onClose={() => setRevokeCandidate(null)} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={() => setRevokeCandidate(null)}>{t('Cancel')}</Button><Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(revokeCandidate.id)}>{t('Revoke credential')}</Button></>}><p>{t('Revoke {name}? Requests using this key will fail immediately.', { name: revokeCandidate.name })}</p></Dialog> : null}
    {deleteConfirmation ? <Dialog title={t('Delete client')} onClose={() => setDeleteConfirmation(false)} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={() => setDeleteConfirmation(false)}>{t('Cancel')}</Button><Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{t('Delete client permanently')}</Button></>}><p>{t('Delete {name}? Credentials and grants will be removed immediately. Historical completed runs are retained.', { name: client.name })}</p>{remove.isError ? <p className="dialog-error">{t('Client could not be deleted')}</p> : null}</Dialog> : null}
  </>;
}

function CredentialDialog({ title, action, defaultName, onClose, onSubmit }: { title: string; action: string; defaultName: string; onClose(): void; onSubmit(name: string, expiresAt: string | null): Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState(defaultName);
  const [expiry, setExpiry] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submit = async () => { setPending(true); setFailed(false); try { await onSubmit(name, dateTimeValue(expiry)); } catch { setFailed(true); setPending(false); } };
  return <Dialog title={title} onClose={onClose} initialFocusRef={cancelRef} actions={<><Button ref={cancelRef} variant="quiet" onClick={onClose}>{t('Cancel')}</Button><Button disabled={!name.trim() || pending} onClick={() => void submit()}>{action}</Button></>}><div className="credential-form"><label className="field"><span>{t('Credential name')}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label><label className="field"><span>{t('Expiry (optional)')}</span><input type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label></div>{failed ? <p className="dialog-error">{t('Credential operation failed')}</p> : null}</Dialog>;
}
