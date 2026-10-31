import type { TicketStatus } from '@watchtower/shared';
import { cn } from '@watchtower/ui';
import {
  Archive,
  Circle,
  CircleCheck,
  CircleDot,
  Code,
  GitMerge,
  Hourglass,
  ListChecks,
  type LucideIcon,
} from 'lucide-react';

import { useT } from '@/i18n/provider';
import { statusKey } from '@/lib/tickets/status-key';

const ICONS: Record<TicketStatus, LucideIcon> = {
  new: Circle,
  triage: ListChecks,
  open: CircleDot,
  waiting_on_customer: Hourglass,
  waiting_on_dev: Code,
  resolved: CircleCheck,
  closed: Archive,
  merged: GitMerge,
};

/** A ticket status as icon + words. Never colour alone. */
export function StatusLabel({ status, className }: { status: TicketStatus; className?: string }) {
  const t = useT();
  const Icon = ICONS[status];
  return (
    <span
      data-status={status}
      className={cn('inline-flex items-center gap-1 text-xs font-medium', className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{t(statusKey(status))}</span>
    </span>
  );
}
