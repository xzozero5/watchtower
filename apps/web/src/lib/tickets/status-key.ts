import type { TicketStatus } from '@watchtower/shared';

import type { MessageKey } from '@/i18n';

/**
 * Copy keys are camelCase (docs/06-UI-SPEC.md section 16) while the api's status values are
 * snake_case. This is the one place that maps between them; the compiler makes it exhaustive.
 */
const STATUS_KEYS: Record<TicketStatus, MessageKey> = {
  new: 'status.new',
  triage: 'status.triage',
  open: 'status.open',
  waiting_on_customer: 'status.waitingOnCustomer',
  waiting_on_dev: 'status.waitingOnDev',
  resolved: 'status.resolved',
  closed: 'status.closed',
  merged: 'status.merged',
};

export function statusKey(status: TicketStatus): MessageKey {
  return STATUS_KEYS[status];
}
