import { useEffect, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'select:not([disabled])',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement>,
  onEscape: () => void,
  initialFocusRef?: RefObject<HTMLElement>,
): void {
  useEffect(() => {
    if (!active || !containerRef.current) return;
    const container = containerRef.current;
    const restoreTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...container.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => !element.hasAttribute('disabled'));
    (initialFocusRef?.current ?? focusable()[0] ?? container).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreTarget?.focus();
    };
  }, [active, containerRef, initialFocusRef, onEscape]);
}
