import { customerStatus, type TicketStatus } from '@watchtower/shared';
import { cn, type DotTone, Pill, StatusDot } from '@watchtower/ui';

import { customerStatusKey } from '@/components/portal/customer-status-label';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
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

/**
 * A ticket status as a coloured dot and words. `pill` wraps it in a neutral 20px pill. A customer
 * user sees the customer words ("In progress" for triage, open and waiting on developers), as on the
 * portal (UI spec section 10).
 */
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
  const { isClient } = useSession();
  const words = isClient ? t(customerStatusKey(customerStatus(status))) : t(statusKey(status));
  const content = (
    <>
      <StatusDot tone={STATUS_TONE[status]} />
      <span className="truncate">{words}</span>
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
