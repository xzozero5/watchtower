import type { TicketStats, TicketStatus } from '@watchtower/shared';
import { z } from 'zod';

/**
 * The counts, switches, holidays and history of the head console come from `@watchtower/shared`
 * (T-127 api, merged). Only what the api keeps to itself is described here.
 */

/** `GET /health/ready` (`apps/api/src/health/health.schema.ts`; not part of the shared contract). */
export const readinessViewSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: z.object({ status: z.enum(['up', 'down']) }),
    redis: z.object({ status: z.enum(['up', 'down']) }),
  }),
});
export type ReadinessView = z.infer<typeof readinessViewSchema>;

/** Open-work statuses sent to the counts endpoint: an empty `status` filter would count them all. */
export const OPEN_WORK_STATUSES: readonly TicketStatus[] = [
  'new',
  'triage',
  'open',
  'waiting_on_customer',
  'waiting_on_dev',
];

/** The number of open tickets in one status; a status with no ticket is not in the list. */
export function openInStatus(stats: TicketStats, status: TicketStatus): number {
  return stats.byStatus.find((entry) => entry.status === status)?.open ?? 0;
}
