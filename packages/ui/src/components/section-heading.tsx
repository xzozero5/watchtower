import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import type { TintId } from '../tokens/colors.js';
import type { ChipIcon } from './tint-chip.js';
import { TINT_CLASSES } from './tint.js';

export interface SectionHeadingProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone: TintId;
  icon: ChipIcon;
  /** The section's name. */
  children: ReactNode;
  /** A count in a soft pill after the name. */
  count?: number;
}

/**
 * The inside of a section header: a coloured dot, an icon in the same hue, the name and a count
 * (docs/design/friendly-polish.md section 3). Put it inside the button or heading that owns the
 * section; it draws no interaction of its own.
 */
export function SectionHeading({
  tone,
  icon: Icon,
  children,
  count,
  className,
  ...props
}: SectionHeadingProps) {
  const classes = TINT_CLASSES[tone];
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} {...props}>
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', classes.dot)} />
      <Icon aria-hidden className={cn('size-3.5 shrink-0', classes.icon)} strokeWidth={2} />
      <span className="truncate">{children}</span>
      {count === undefined ? null : (
        <span className="tabular rounded-full bg-surface-muted px-1.5 text-foreground">
          {count}
        </span>
      )}
    </span>
  );
}
