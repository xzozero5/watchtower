import {
  aiSwitchSchema,
  autonomyStateSchema,
  businessCalendarSchema,
  holidaySchema,
  setAiSwitchResultSchema,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import { z } from 'zod';

/**
 * Response shapes the head console (T-127) reads that `@watchtower/shared` does not define yet.
 * They extend the shared schemas where one exists. Each is `[ASSUMED]` from docs/06-UI-SPEC.md
 * section 18.9 (H2, H3, H4, H6) until the api task publishes the real ones; then these move to
 * `@watchtower/shared` and this file shrinks to re-exports. Everything optional here is optional
 * on purpose: an api that does not send the field yet must still work.
 */

// --- H2: GET /v1/tickets/stats, the same filters as the ticket list ---

const countRecord = <Key extends string>(keys: readonly Key[]) =>
  z.partialRecord(z.enum(keys as [Key, ...Key[]]), z.number().int().min(0));

export const ticketStatsSchema = z.object({
  byStatus: countRecord(TICKET_STATUSES),
  byQueue: z.array(
    z.object({ queueId: z.uuid().nullable(), name: z.string().nullable(), n: z.number().int() }),
  ),
  byAssignee: z.array(
    z.object({ userId: z.uuid().nullable(), name: z.string().nullable(), n: z.number().int() }),
  ),
  byPriority: countRecord(TICKET_PRIORITIES),
  bySlaState: z.object({
    ok: z.number().int().min(0),
    at_risk: z.number().int().min(0),
    breached: z.number().int().min(0),
    paused: z.number().int().min(0),
  }),
});
export type TicketStats = z.infer<typeof ticketStatsSchema>;

/** Count of one status or priority in a stats record; a missing key is zero. */
export function statCount(
  record: Partial<Record<TicketStatus | TicketPriority, number>>,
  key: TicketStatus | TicketPriority,
): number {
  return record[key] ?? 0;
}

// --- H3: the switch carries the name of who flipped it ---

export const aiSwitchWithNameSchema = aiSwitchSchema.extend({
  changedByName: z.string().nullable().optional(),
});
export type AiSwitchView = z.infer<typeof aiSwitchWithNameSchema>;

export const autonomyViewSchema = autonomyStateSchema.extend({
  switches: z.array(aiSwitchWithNameSchema),
});
export type AutonomyView = z.infer<typeof autonomyViewSchema>;

export const setSwitchResultViewSchema = setAiSwitchResultSchema.extend({
  switches: z.array(aiSwitchWithNameSchema),
});

// --- H4: a holiday has a "checked against the official announcement" flag ---

export const holidayViewSchema = holidaySchema.extend({
  checked: z.boolean().optional(),
  checkedBy: z.string().nullable().optional(),
  checkedAt: z.iso.datetime().nullable().optional(),
});
export type HolidayView = z.infer<typeof holidayViewSchema>;

export const calendarViewSchema = businessCalendarSchema.extend({
  holidays: z.array(holidayViewSchema),
});
export type CalendarView = z.infer<typeof calendarViewSchema>;
export const calendarViewListSchema = z.object({ calendars: z.array(calendarViewSchema) });

// --- H6: GET /v1/intents/:id/autonomy/history ---

export const autonomyHistoryEntrySchema = z.object({
  id: z.string(),
  change: z.enum(['stage', 'pin', 'unpin']),
  fromStage: z.number().int().nullable(),
  toStage: z.number().int().nullable(),
  pinned: z.boolean().nullable().optional(),
  reason: z.string(),
  changedBy: z.string().nullable(),
  changedByName: z.string().nullable().optional(),
  changedAt: z.iso.datetime(),
});
export type AutonomyHistoryEntry = z.infer<typeof autonomyHistoryEntrySchema>;
export const autonomyHistorySchema = z.object({ entries: z.array(autonomyHistoryEntrySchema) });

// --- GET /health/ready ---

export const readinessViewSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.object({
    database: z.object({ status: z.enum(['up', 'down']) }),
    redis: z.object({ status: z.enum(['up', 'down']) }),
  }),
});
export type ReadinessView = z.infer<typeof readinessViewSchema>;
