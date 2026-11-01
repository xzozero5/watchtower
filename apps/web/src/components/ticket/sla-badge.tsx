import { type ChipIcon, cn, TintChip, type TintId } from '@watchtower/ui';
import { CircleAlert, CircleCheck, CirclePause, Clock, Hourglass } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import { formatDateTime, formatDuration } from '@/lib/format';
import type { SlaState, SlaView } from '@/lib/tickets/sla';

const LOOK: Record<SlaState, { icon: ChipIcon; tone: TintId }> = {
  onTrack: { icon: Clock, tone: 'green' },
  atRisk: { icon: Hourglass, tone: 'amber' },
  breached: { icon: CircleAlert, tone: 'red' },
  paused: { icon: CirclePause, tone: 'slate' },
  met: { icon: CircleCheck, tone: 'green' },
  none: { icon: Clock, tone: 'slate' },
};

/**
 * Where a ticket stands against its SLA (docs/06-UI-SPEC.md section 4.4): a soft tinted chip with an
 * icon and words (green on track or met, amber at risk, red breached, slate paused), so no state
 * depends on colour. The full sentence is in the tooltip and
 * the accessible name. It shows the next due target, first response until answered, then resolution.
 */
export function SlaBadge({ sla, className }: { sla: SlaView; className?: string }) {
  const { t, locale } = useI18n();
  if (sla.state === 'none') return null;

  const { icon, tone } = LOOK[sla.state];
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
    <TintChip
      tone={tone}
      icon={icon}
      strong={sla.state === 'breached'}
      data-sla={sla.state}
      title={full}
      aria-label={full}
      role="img"
      className={cn('tabular', className)}
    >
      <span aria-hidden>{text}</span>
    </TintChip>
  );
}
