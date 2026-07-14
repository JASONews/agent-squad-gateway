import type { ReactNode } from 'react';

type FieldRequirement = 'required' | 'optional';

export function Field({
  label,
  hint,
  requirement,
  children,
}: {
  label: string;
  hint?: string;
  requirement?: FieldRequirement;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>
        <span className={requirement ? `field__label field__label--${requirement}` : undefined}>{label}</span>
        {children}
      </label>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}
