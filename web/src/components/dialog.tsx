import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './focus-trap.js';

interface DialogProps {
  title: string;
  onClose(): void;
  initialFocusRef?: RefObject<HTMLElement>;
  children: ReactNode;
  actions: ReactNode;
  wide?: boolean;
}

export function Dialog({ title, onClose, initialFocusRef, children, actions, wide = false }: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = `dialog-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.app-shell');
    shell?.setAttribute('inert', '');
    return () => shell?.removeAttribute('inert');
  }, []);
  useFocusTrap(true, dialogRef, close, initialFocusRef);

  return createPortal(
    <div className="dialog-layer">
      <div
        ref={dialogRef}
        className={`dialog ${wide ? 'dialog--wide' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="dialog-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
