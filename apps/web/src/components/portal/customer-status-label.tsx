import type { CustomerStatus } from '@watchtower/shared';
import { cn } from '@watchtower/ui';
import {
  Archive,
  CircleCheck,
  CircleDot,
  Circle,
  GitMerge,
  Hourglass,
  type LucideIcon,
} from 'lucide-react';

import type { MessageKey } from '@/i18n';
import { useT } from '@/i18n/provider';

const ICONS: Record<CustomerStatus, LucideIcon> = {
  received: Circle,
  in_progress: CircleDot,
  waiting_for_you: Hourglass,
  resolved: CircleCheck,
  closed: Archive,
  merged: GitMerge,
};

/** Copy keys are camelCase (docs/06-UI-SPEC.md section 16); the api's values are snake_case. */
const KEYS: Record<CustomerStatus, MessageKey> = {
  received: 'portal.status.received',
  in_progress: 'portal.status.inProgress',
  waiting_for_you: 'portal.status.waitingForYou',
  resolved: 'portal.status.resolved',
  closed: 'portal.status.closed',
  merged: 'portal.status.merged',
};

export function customerStatusKey(status: CustomerStatus): MessageKey {
  return KEYS[status];
}

/**
 * A ticket status in the words a customer sees (UI spec section 10): icon + words, never colour
 * alone. Used by the portal and by the client view of the workspace. Pass `mergedInto` to read
 * "Merged into OPS-12".
 */
export function CustomerStatusLabel({
  status,
  mergedInto,
  className,
}: {
  status: CustomerStatus;
  mergedInto?: string | null;
  className?: string;
}) {
  const t = useT();
  const Icon = ICONS[status];
  const text =
    status === 'merged' && mergedInto
      ? t('portal.status.mergedInto', { key: mergedInto })
      : t(KEYS[status]);
  return (
    <span
      data-customer-status={status}
      className={cn('inline-flex items-center gap-1 text-xs font-medium', className)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>{text}</span>
    </span>
  );
}
