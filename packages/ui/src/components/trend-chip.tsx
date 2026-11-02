import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { TINT_CLASSES } from './tint.js';

export type TrendDirection = 'up' | 'down' | 'flat';

/**
 * What the change means, not which way it points: fewer open tickets is `good` even though the
 * arrow points down, more volume is `neutral` (docs/design/redesign-2026-11 section 4). Never red:
 * red is for P1 and breaches only.
 */
export type TrendMeaning = 'good' | 'bad' | 'neutral';

export interface TrendChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  direction: TrendDirection;
  meaning: TrendMeaning;
  /** The words, always shown ("+12% vs last week"): the colour and arrow never carry it alone. */
  label: string;
}

const ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;
const TONES = { good: 'green', bad: 'amber', neutral: 'slate' } as const;

/** A change against an earlier period: arrow, words and a soft tint that says good, bad or neutral. */
export function TrendChip({ direction, meaning, label, className, ...props }: TrendChipProps) {
  const Icon = ICONS[direction];
  const classes = TINT_CLASSES[TONES[meaning]];
  return (
    <span
      data-meaning={meaning}
      className={cn(
        'tabular inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        classes.chip,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className={cn('size-3.5 shrink-0', classes.icon)} />
      {label}
    </span>
  );
}
