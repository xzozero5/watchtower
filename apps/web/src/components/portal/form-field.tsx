import { cn } from '@watchtower/ui';
import { CircleX } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Label above the control, optional hint, inline error. The control gets `aria-describedby` from
 * `describedBy(id, ...)` so a screen reader reads the hint and the error with the field.
 */
export function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(
    (value) => value !== null,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

export function FormField({
  id,
  label,
  optionalLabel,
  hint,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  /** The word "optional" in the page language, shown after the label of an optional field. */
  optionalLabel?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optionalLabel ? (
          <span className="font-normal text-muted-foreground"> ({optionalLabel})</span>
        ) : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
