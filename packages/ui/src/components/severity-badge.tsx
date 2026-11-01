import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ComponentType, HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import type { TintId } from '../tokens/colors.js';
import { SEVERITIES, type SeverityIconName, type SeverityId } from '../tokens/severity.js';
import { TINT_CLASSES } from './tint.js';

const ICONS: Record<
  SeverityIconName,
  ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: true }>
> = {
  'octagon-alert': OctagonAlert,
  'triangle-alert': TriangleAlert,
  'circle-alert': CircleAlert,
  info: Info,
};

// One soft tint per level (docs/design/friendly-polish.md section 3): P1 red and heavier, P2 amber,
// P3 sky, P4 slate. Only P1 is strong, so a screen full of tickets does not turn into a wall of red.
const TINT: Record<SeverityId, TintId> = { p1: 'red', p2: 'amber', p3: 'sky', p4: 'slate' };

export interface SeverityBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  severity: SeverityId;
  /** Translated name of the level, for example "Critical". Required so callers go through i18n. */
  label: string;
  /** Hide the word and keep the icon and code. The label stays available to screen readers. */
  hideLabel?: boolean;
  /**
   * No pill: a coloured icon and the code as plain text, for a dense list where priority must not
   * read as a status. P1 keeps its pill, the one level that has to stand out.
   */
  plain?: boolean;
}

/**
 * Severity as icon + code + label. Colour is only reinforcement (PRD section 10): drop the colours
 * and each level is still told apart by its icon shape and its text.
 */
export function SeverityBadge({
  severity,
  label,
  hideLabel = false,
  plain = false,
  className,
  ...props
}: SeverityBadgeProps) {
  const { code, icon } = SEVERITIES[severity];
  const Icon = ICONS[icon];
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap',
        plain && severity !== 'p1' ? 'px-0 text-foreground' : TINT_CLASSES[TINT[severity]].chip,
        severity === 'p1' && 'font-semibold ring-1 ring-current/30 ring-inset',
        className,
      )}
      {...props}
    >
      <Icon
        aria-hidden
        className={cn('size-3.5 shrink-0', TINT_CLASSES[TINT[severity]].icon)}
        strokeWidth={2}
      />
      <span>{code}</span>
      {/* A real space, so the text reads "P1 Critical" to a screen reader and to Label-in-Name. */}{' '}
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}
