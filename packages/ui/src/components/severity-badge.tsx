import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ComponentType, HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { SEVERITIES, type SeverityIconName, type SeverityId } from '../tokens/severity.js';

const ICONS: Record<
  SeverityIconName,
  ComponentType<{ className?: string; strokeWidth?: number; 'aria-hidden'?: true }>
> = {
  'octagon-alert': OctagonAlert,
  'triangle-alert': TriangleAlert,
  'circle-alert': CircleAlert,
  info: Info,
};

// Full class names, so Tailwind can see them when it scans this file. Only P1 is filled: the
// other levels are outlined, so a screen full of tickets does not turn into a wall of colour.
const TONE: Record<SeverityId, string> = {
  p1: 'border-sev-p1-border bg-sev-p1-bg text-sev-p1-fg font-semibold',
  p2: 'border-sev-p2-border bg-transparent text-sev-p2-fg',
  p3: 'border-sev-p3-border bg-transparent text-sev-p3-fg',
  p4: 'border-sev-p4-border bg-transparent text-sev-p4-fg',
};

export interface SeverityBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  severity: SeverityId;
  /** Translated name of the level, for example "Critical". Required so callers go through i18n. */
  label: string;
  /** Hide the word and keep the icon and code. The label stays available to screen readers. */
  hideLabel?: boolean;
}

/**
 * Severity as icon + code + label. Colour is only reinforcement (PRD section 10): drop the colours
 * and each level is still told apart by its icon shape and its text.
 */
export function SeverityBadge({
  severity,
  label,
  hideLabel = false,
  className,
  ...props
}: SeverityBadgeProps) {
  const { code, icon } = SEVERITIES[severity];
  const Icon = ICONS[icon];
  return (
    <span
      data-severity={severity}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap',
        TONE[severity],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span>{code}</span>
      {/* A real space, so the text reads "P1 Critical" to a screen reader and to Label-in-Name. */}{' '}
      <span className={hideLabel ? 'sr-only' : undefined}>{label}</span>
    </span>
  );
}
