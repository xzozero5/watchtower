import type { TicketStatus } from '@watchtower/shared';
import { cn, type DotTone, Pill, StatusDot } from '@watchtower/ui';

import { useT } from '@/i18n/provider';
import { statusKey } from '@/lib/tickets/status-key';

/**
 * The dot says "where in the life of the ticket" (working, waiting, finished); the words say which
 * status exactly. The dot is never the only signal.
 */
export const STATUS_TONE: Record<TicketStatus, DotTone> = {
  new: 'info',
  triage: 'outline',
  open: 'info',
  waiting_on_customer: 'outline',
  waiting_on_dev: 'outline',
  resolved: 'success',
  closed: 'muted',
  merged: 'muted',
};

/** A ticket status as a coloured dot and words. `pill` wraps it in a neutral 20px pill. */
export function StatusLabel({
  status,
  pill = false,
  className,
}: {
  status: TicketStatus;
  pill?: boolean;
  className?: string;
}) {
  const t = useT();
  const content = (
    <>
      <StatusDot tone={STATUS_TONE[status]} />
      <span className="truncate">{t(statusKey(status))}</span>
    </>
  );
  if (pill) {
    return (
      <Pill data-status={status} className={className}>
        {content}
      </Pill>
    );
  }
  return (
    <span
      data-status={status}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', className)}
    >
      {content}
    </span>
  );
}
