import { Copy, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, IconButton } from './button.js';
import { Dialog } from './dialog.js';
import { useI18n } from '../app/i18n.js';

interface RawTailProps {
  alias: string;
  tail: string | null;
  onClose(): void;
}

export function RawTail({ alias, tail, onClose }: RawTailProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copy = async () => {
    if (tail === null) return;
    try {
      await navigator.clipboard.writeText(tail);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <Dialog
      title={t('Raw tail: {alias}', { alias })}
      onClose={onClose}
      initialFocusRef={closeRef}
      wide
      actions={<>
        <IconButton label={t('Copy raw tail for {alias}', { alias })} disabled={tail === null} onClick={() => void copy()}>
          <Copy size={16} aria-hidden="true" />
        </IconButton>
        <Button ref={closeRef} variant="quiet" onClick={onClose}>
          <X size={16} aria-hidden="true" /> {t('Close')}
        </Button>
      </>}
    >
      <div className="raw-tail">
        {tail === null
          ? <p className="raw-tail__empty">{t('No raw tail available.')}</p>
          : <pre className="raw-tail__content">{tail}</pre>}
        {copyFailed ? <p className="dialog-error" role="alert">{t('Raw tail copy failed')}</p> : null}
      </div>
    </Dialog>
  );
}
