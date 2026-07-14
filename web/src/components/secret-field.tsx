import { Copy, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './button.js';
import { useI18n } from '../app/i18n.js';

interface SecretFieldProps {
  label: string;
  prefix: string;
  initialSecret?: string;
  reveal(): Promise<string>;
}

export function SecretField({ label, prefix, initialSecret, reveal }: SecretFieldProps) {
  const { t } = useI18n();
  const [secret, setSecret] = useState<string | null>(initialSecret ?? null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setSecret(initialSecret ?? null);
    setLoading(false);
    setFailed(false);
    return () => { requestId.current += 1; };
  }, [initialSecret, prefix]);

  const show = async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setFailed(false);
    try {
      const plaintext = await reveal();
      if (requestId.current === currentRequest) setSecret(plaintext);
    } catch {
      if (requestId.current === currentRequest) setFailed(true);
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  };
  const hide = () => { requestId.current += 1; setSecret(null); setLoading(false); setFailed(false); };
  const copy = async () => {
    if (secret === null) return;
    try { await navigator.clipboard.writeText(secret); } catch { setFailed(true); }
  };

  return <div className="secret-field">
    {secret === null
      ? <span className="secret-field__mask">{prefix}_••••••••</span>
      : <input aria-label={t('Key {label}', { label })} value={secret} readOnly autoComplete="off" spellCheck={false} />}
    <IconButton label={t(secret === null ? 'Reveal key {label}' : 'Hide key {label}', { label })} disabled={loading} onClick={() => void (secret === null ? show() : hide())}>
      {secret === null ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
    </IconButton>
    <IconButton label={t('Copy key {label}', { label })} disabled={secret === null} onClick={() => void copy()}>
      <Copy size={15} aria-hidden="true" />
    </IconButton>
    {failed ? <span className="secret-field__error" role="alert">{t('Key operation failed')}</span> : null}
  </div>;
}
