import type { ComponentType, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import type { TintId } from '../tokens/colors.js';
import { TINT_CLASSES } from './tint.js';

export type ChipIcon = ComponentType<{
  className?: string;
  strokeWidth?: number;
  'aria-hidden'?: true;
}>;

export interface TintChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** The hue. The meaning (priority, SLA, AI state) is carried by the icon and the words. */
  tone: TintId;
  /** A lucide icon. Always drawn in the full hue. */
  icon?: ChipIcon;
  /** The words: two at most. Hidden visually (kept for screen readers) with `iconOnly`. */
  children?: ReactNode;
  /** Draw the icon only. The words stay as the accessible name and as a tooltip. */
  iconOnly?: boolean;
  /** A heavier chip for the one level that must stand out (P1, a breach). */
  strong?: boolean;
  /** Lifts 1 px on hover (not under reduced motion). Use it for chips that are buttons. */
  interactive?: boolean;
}

/**
 * A soft tinted chip: a 13 % tint of the hue, dark text, the icon in the full hue
 * (docs/design/friendly-polish.md section 3). Colour is never the only signal: the icon shape and
 * the words say the same thing. Fully round, 20 px high, no outline.
 */
export function TintChip({
  tone,
  icon: Icon,
  children,
  iconOnly = false,
  strong = false,
  interactive = false,
  className,
  title,
  ...props
}: TintChipProps) {
  const classes = TINT_CLASSES[tone];
  const words = typeof children === 'string' ? children : undefined;
  return (
    <span
      data-tone={tone}
      title={title ?? (iconOnly ? words : undefined)}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        classes.chip,
        strong && 'font-semibold ring-1 ring-current/30 ring-inset',
        iconOnly && 'px-1',
        interactive &&
          'transition-transform duration-(--wt-motion-duration-fast) ease-out motion-safe:hover:-translate-y-px',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon aria-hidden className={cn('size-3.5 shrink-0', classes.icon)} strokeWidth={2} />
      ) : null}
      {children === undefined || children === null ? null : (
        <span className={cn('min-w-0', iconOnly && 'sr-only')}>{children}</span>
      )}
    </span>
  );
}
