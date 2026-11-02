/**
 * Head console administration (T-127): this feature's own audit actions, ticket event types and queue
 * names (T-123a). The HTTP schemas live next to the data they describe (`../ticketing.ts`,
 * `../sla.ts`, `../directory.ts`, `../auth.ts`, `./autonomy.ts`).
 */

/** Audit `action` strings written by this feature. */
export const ADMIN_AUDIT_ACTIONS = {
  /** The audit log was exported as CSV (who, which filters, how many rows). */
  auditLogExport: 'audit.log.export',
  /** A person marked a holiday as checked (or unchecked) against the official announcement. */
  calendarHolidayChecked: 'business_calendar.holiday_checked',
  /** A head put a dead outbox row back in the queue (T-121a). */
  outboxResend: 'outbox.resend',
  orgTierCreate: 'org_tier.create',
  orgTierUpdate: 'org_tier.update',
  orgTierDelete: 'org_tier.delete',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const ADMIN_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const ADMIN_QUEUES = {} as const satisfies Record<string, string>;
