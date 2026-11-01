import type { CustomerStatus } from '@watchtower/shared';
import { type ChipIcon, TintChip, type TintId } from '@watchtower/ui';
import { Archive, CircleCheck, CircleDot, Circle, GitMerge, Hourglass } from 'lucide-react';

import type { MessageKey } from '@/i18n';
import { useT } from '@/i18n/provider';

const LOOK: Record<CustomerStatus, { icon: ChipIcon; tone: TintId }> = {
  received: { icon: Circle, tone: 'sky' },
  in_progress: { icon: CircleDot, tone: 'teal' },
  waiting_for_you: { icon: Hourglass, tone: 'amber' },
  resolved: { icon: CircleCheck, tone: 'green' },
  closed: { icon: Archive, tone: 'slate' },
  merged: { icon: GitMerge, tone: 'slate' },
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
 * A ticket status in the words a customer sees (UI spec section 10): a soft tinted chip with icon
 * and words, never colour alone. Used by the portal and by the client view of the workspace. Pass `mergedInto` to read
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
  const { icon, tone } = LOOK[status];
  const text =
    status === 'merged' && mergedInto
      ? t('portal.status.mergedInto', { key: mergedInto })
      : t(KEYS[status]);
  return (
    <TintChip tone={tone} icon={icon} data-customer-status={status} className={className}>
      {text}
    </TintChip>
  );
}
