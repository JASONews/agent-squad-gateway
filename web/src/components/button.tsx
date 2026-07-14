import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'danger' | 'quiet';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className = '', variant = 'default', ...props },
  ref,
) {
  return <button ref={ref} className={`button button--${variant} ${className}`.trim()} {...props} />;
});

interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label' | 'title'> {
  label: string;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className = '', ...props },
  ref,
) {
  const { children, ...buttonProps } = props;
  return (
    <Button
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      ref={ref}
      {...buttonProps}
    >
      {children}
    </Button>
  );
});
