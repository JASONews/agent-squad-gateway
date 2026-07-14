import type { ReactNode } from 'react';

interface ToggleProps {
  label: string;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  required?: boolean;
  showLabel?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Toggle({
  label,
  checked,
  onCheckedChange,
  disabled = false,
  required = false,
  showLabel = false,
  className = '',
  children,
}: ToggleProps) {
  const hasVisibleLabel = showLabel || children !== undefined;
  return (
    <button
      type="button"
      role="switch"
      className={`toggle-control ${hasVisibleLabel ? 'toggle-control--labelled' : ''} ${className}`.trim()}
      aria-checked={checked}
      aria-label={label}
      aria-required={required || undefined}
      title={hasVisibleLabel ? undefined : label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="toggle-control__track" aria-hidden="true">
        <span className="toggle-control__thumb" />
      </span>
      {hasVisibleLabel ? <span className="toggle-control__label" aria-hidden="true">{children ?? label}</span> : null}
    </button>
  );
}
