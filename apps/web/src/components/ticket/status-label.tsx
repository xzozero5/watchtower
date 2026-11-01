import { customerStatus, type TicketStatus } from '@watchtower/shared';
import {
  type ChipIcon,
  cn,
  type DotTone,
  Pill,
  StatusDot,
  TintChip,
  type TintId,
} from '@watchtower/ui';
import {
  Archive,
  CircleCheck,
  CodeXml,
  GitMerge,
  Hourglass,
  Inbox,
  ListChecks,
  Loader,
} from 'lucide-react';

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
  const customer = isClient ? customerStatus(status) : undefined;
  const words = customer ? t(customerStatusKey(customer)) : t(statusKey(status));
  const attrs = customer ? { 'data-customer-status': customer } : { 'data-status': status };
  const content = (
    <>
      <StatusDot tone={STATUS_TONE[status]} />
      <span className="truncate">{words}</span>
    </>
  );
  if (pill) {
    return (
      <Pill {...attrs} className={className}>
        {content}
      </Pill>
    );
  }
  return (
    <span
      {...attrs}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs font-medium', className)}
    >
      {content}
    </span>
  );
}

const CHIP_LOOK: Record<TicketStatus, { icon: ChipIcon; tone: TintId }> = {
  new: { icon: Inbox, tone: 'sky' },
  triage: { icon: ListChecks, tone: 'violet' },
  open: { icon: Loader, tone: 'sky' },
  waiting_on_customer: { icon: Hourglass, tone: 'sky' },
  waiting_on_dev: { icon: CodeXml, tone: 'indigo' },
  resolved: { icon: CircleCheck, tone: 'green' },
  closed: { icon: Archive, tone: 'slate' },
  merged: { icon: GitMerge, tone: 'slate' },
};

/** The words of a status for this reader (a customer sees the customer words). */
export function useStatusWords(status: TicketStatus): {
  words: string;
  attrs: Record<string, string>;
} {
  const t = useT();
  const { isClient } = useSession();
  const customer = isClient ? customerStatus(status) : undefined;
  return {
    words: customer ? t(customerStatusKey(customer)) : t(statusKey(status)),
    attrs: customer ? { 'data-customer-status': customer } : { 'data-status': status },
  };
}

/**
 * The workflow status as a filled tinted chip, for the one status slot of a queue row (the same
 * look as the AI state chip: a status is the only filled pill on a row).
 */
export function StatusChip({ status, className }: { status: TicketStatus; className?: string }) {
  const { words, attrs } = useStatusWords(status);
  const { icon, tone } = CHIP_LOOK[status];
  return (
    <TintChip tone={tone} icon={icon} className={className} {...attrs}>
      {words}
    </TintChip>
  );
}
