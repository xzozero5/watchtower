import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const CONFIDENCE_DOTS = 5;

/** How many of the five dots are lit for a confidence from 0 to 1 (0.86 lights 4, 0.9 lights 5). */
export function litDots(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * CONFIDENCE_DOTS);
}

export interface ConfidenceDotsProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Confidence from 0 to 1. */
  value: number;
  /** The words and number, for example "Confidence High 0.86": the accessible name and tooltip. */
  label: string;
  /** Draw low confidence in the muted tone, not the AI tone. */
  low?: boolean;
}

/**
 * A five-dot confidence bar (docs/design/friendly-polish.md section 4). The number is not drawn:
 * it is the `aria-label` and the tooltip, so the bar stays small and a screen reader still hears it.
 * Lit dots are filled, unlit ones are hollow rings, so the count reads without colour.
 */
export function ConfidenceDots({
  value,
  label,
  low = false,
  className,
  ...props
}: ConfidenceDotsProps) {
  const lit = litDots(value);
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      title={label}
      data-lit={lit}
      className={cn('inline-flex items-center gap-1', className)}
      {...props}
    >
      {Array.from({ length: CONFIDENCE_DOTS }, (_, index) => (
        <span
          key={index}
          aria-hidden
          data-on={index < lit ? 'true' : 'false'}
          className={cn(
            'size-2 rounded-full border-[1.5px]',
            index < lit
              ? low
                ? 'border-muted-foreground bg-muted-foreground'
                : 'border-ai-accent bg-ai-accent'
              : 'border-border-strong bg-transparent',
          )}
        />
      ))}
    </span>
  );
}
