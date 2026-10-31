import { cn } from '@watchtower/ui';
import {
  AlarmClockOff,
  CircleCheck,
  CirclePause,
  Clock,
  ClockAlert,
  type LucideIcon,
} from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { SlaState, SlaView } from '@/lib/tickets/sla';

const ICONS: Record<SlaState, LucideIcon> = {
  onTrack: Clock,
  atRisk: ClockAlert,
  breached: AlarmClockOff,
  paused: CirclePause,
  met: CircleCheck,
  none: Clock,
};

/**
 * Where a ticket stands against its SLA (docs/06-UI-SPEC.md section 4.4): an icon, words and a
 * border style per state, so no state depends on colour. The full sentence is in the tooltip and
 * the accessible name. It shows the next due target, first response until answered, then resolution.
 */
export function SlaBadge({ sla, className }: { sla: SlaView; className?: string }) {
  const { t, locale } = useI18n();
  if (sla.state === 'none') return null;

  const Icon = ICONS[sla.state];
  const target = sla.target === null ? '' : t(`sla.${sla.target}`);
  const time = formatDuration(sla.ms, locale);
  const text =
    sla.state === 'onTrack'
      ? t('sla.onTrack', { target, time })
      : sla.state === 'atRisk'
        ? `${target} ${t('sla.atRisk', { time })}`
        : sla.state === 'breached'
          ? t('sla.breached', { time })
          : sla.state === 'paused'
            ? t('sla.paused')
            : t('sla.met');
  const due =
    sla.target !== null && sla.dueAt !== null
      ? t(`sla.due.${sla.target}`, { at: formatDateTime(sla.dueAt, locale) })
      : null;
  const full = due ? `${text} — ${due}` : text;

  return (
    <span
      data-sla={sla.state}
      title={full}
      aria-label={full}
      role="img"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs whitespace-nowrap',
        sla.state === 'breached' && 'border-danger font-semibold text-danger',
        sla.state === 'atRisk' && 'border-border-strong font-semibold text-foreground',
        sla.state === 'onTrack' && 'border-transparent text-muted-foreground',
        sla.state === 'paused' && 'border-transparent text-muted-foreground',
        sla.state === 'met' && 'border-transparent font-medium text-success',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span aria-hidden>{text}</span>
    </span>
  );
}
