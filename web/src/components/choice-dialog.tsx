import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { adminFetch, GatewayHttpError } from '../api/client.js';
import type { CoreChoice } from '../api/types.js';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { useI18n } from '../app/i18n.js';

interface ChoiceDialogProps {
  choice: CoreChoice;
  onClose(): void;
  onResolved(): void;
  onConflict(): void;
}

export function ChoiceDialog({ choice, onClose, onResolved, onConflict }: ChoiceDialogProps) {
  const { t } = useI18n();
  const recommended = choice.recommendation?.option_id;
  const [selected, setSelected] = useState(
    recommended && choice.options.some((option) => option.id === recommended) ? recommended : '',
  );
  const [rationale, setRationale] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstOptionRef = useRef<HTMLInputElement>(null);
  const pendingStatusRef = useRef<HTMLParagraphElement>(null);
  const pendingRef = useRef(false);
  const formId = `resolve-${choice.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const close = useCallback(() => { if (!pendingRef.current) onClose(); }, [onClose]);

  useEffect(() => {
    (pending ? pendingStatusRef : firstOptionRef).current?.focus();
  }, [pending]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const trimmedRationale = rationale.trim();
    try {
      await adminFetch<void>(
        `/admin/core/sessions/${encodeURIComponent(choice.session_id)}/choices/${encodeURIComponent(choice.id)}/resolve`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            selected,
            ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
          }),
        },
      );
      onResolved();
    } catch (cause) {
      if (cause instanceof GatewayHttpError && cause.status === 409) {
        onConflict();
        return;
      }
      setError(cause instanceof Error ? cause.message : t('Choice resolution failed.'));
      pendingRef.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title={choice.question}
      onClose={close}
      initialFocusRef={firstOptionRef}
      actions={<>
        <Button type="button" variant="quiet" disabled={pending} onClick={close}>{t('Cancel')}</Button>
        <Button type="submit" form={formId} disabled={!selected || pending}>
          {pending ? t('Submitting...') : t('Submit choice')}
        </Button>
      </>}
    >
      <form id={formId} className="choice-form" onSubmit={(event) => void submit(event)}>
        {choice.recommendation ? (
          <p className="choice-recommendation">
            <strong>{t('Recommendation')}</strong>
            <span>{choice.recommendation.reason}</span>
          </p>
        ) : null}
        <fieldset disabled={pending}>
          <legend>{t('Select one option')}</legend>
          {choice.options.map((option, index) => (
            <label className="choice-option" key={option.id}>
              <input
                ref={index === 0 ? firstOptionRef : undefined}
                type="radio"
                name={`choice-${choice.id}`}
                value={option.id}
                checked={selected === option.id}
                disabled={pending}
                required
                onChange={() => setSelected(option.id)}
              />
              <span>
                <strong>{option.label}</strong>
                {option.tradeoff ? <small>{option.tradeoff}</small> : null}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="choice-rationale">
          <span>{t('Rationale')}</span>
          <textarea
            aria-label={t('Rationale')}
            value={rationale}
            disabled={pending}
            rows={3}
            onChange={(event) => setRationale(event.target.value)}
          />
          <small>{t('Optional')}</small>
        </label>
        {pending ? (
          <p ref={pendingStatusRef} role="status" tabIndex={0}>{t('Submitting choice. Please wait.')}</p>
        ) : null}
        {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );
}
