import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { ComponentType, HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { SEVERITIES, type SeverityIconName, type SeverityId } from '../tokens/severity.js';

const ICONS: Record<
  SeverityIconName,
  ComponentType<{ className?: string; 'aria-hidden'?: true }>
> = {
  'octagon-alert': OctagonAlert,
  'triangle-alert': TriangleAlert,
  'circle-alert': CircleAlert,
  info: Info,
};

// Full class names, so Tailwind can see them when it scans this file.
const TONE: Record<SeverityId, string> = {
  p1: 'border-sev-p1-border bg-sev-p1-bg text-sev-p1-fg',
  p2: 'border-sev-p2-border bg-sev-p2-bg text-sev-p2-fg',
  p3: 'border-sev-p3-border bg-sev-p3-bg text-sev-p3-fg',
  p4: 'border-sev-p4-border bg-sev-p4-bg text-sev-p4-fg',
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
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONE[severity],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{code}</span>
      <span className={hideLabel ? 'sr-only' : 'font-medium'}>{label}</span>
    </span>
  );
}
