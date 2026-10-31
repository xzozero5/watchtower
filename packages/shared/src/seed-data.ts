import { z } from 'zod';

import { calendarDateSchema, slaTargetsSchema, timezoneSchema } from './sla.js';

/**
 * Shape of the example files the development seed reads from `examples/` (T-008). They live here,
 * next to the other schemas, so that `packages/db` (which has no direct use for zod) can validate
 * them and tests can too. The application itself never reads these files.
 */

/** Claim tags every example file must carry (AGENTS.md labels). */
export const VERIFY_TAG = '[VERIFY]';
export const ASSUMED_TAG = '[ASSUMED]';

export const HOLIDAY_ENTRY_STATUSES = ['verify', 'unverified'] as const;

/**
 * `examples/calendars/*.json`: public holidays of one calendar. `_meta.status` must say `[VERIFY]`
 * so that nobody mistakes example data for an official list (N5); the check is mechanical.
 */
export const holidayFileSchema = z
  .object({
    _meta: z
      .object({
        status: z.string().refine((value) => value.includes(VERIFY_TAG), {
          message: `_meta.status must carry the ${VERIFY_TAG} tag`,
        }),
        sourceToCheck: z.string().min(10),
        unverified: z.string().refine((value) => value.includes('[UNVERIFIED]'), {
          message: '_meta.unverified must carry the [UNVERIFIED] tag',
        }),
        years: z.array(z.number().int().min(2000).max(2100)).min(1),
      })
      .loose(),
    calendar: z.object({ name: z.string().trim().min(1).max(200), timezone: timezoneSchema }),
    holidays: z
      .array(
        z.object({
          date: calendarDateSchema,
          name: z.string().trim().min(1).max(200),
          status: z.enum(HOLIDAY_ENTRY_STATUSES),
        }),
      )
      .min(1)
      .max(400),
  })
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.holidays.forEach((holiday, index) => {
      if (seen.has(holiday.date)) {
        context.addIssue({
          code: 'custom',
          message: `date ${holiday.date} appears twice`,
          path: ['holidays', index, 'date'],
        });
      }
      seen.add(holiday.date);
      if (!file._meta.years.includes(Number(holiday.date.slice(0, 4)))) {
        context.addIssue({
          code: 'custom',
          message: `date ${holiday.date} is outside _meta.years`,
          path: ['holidays', index, 'date'],
        });
      }
    });
  });
export type HolidayFile = z.infer<typeof holidayFileSchema>;

/** `examples/sla/*.json`: one SLA policy per tier, numbers `[ASSUMED]` unless the file says decided. */
export const slaPolicyFileSchema = z.object({
  _meta: z
    .object({
      status: z.string().refine((value) => value.includes(ASSUMED_TAG), {
        message: `_meta.status must carry the ${ASSUMED_TAG} tag`,
      }),
    })
    .loose(),
  policies: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        tier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
        /** Name of the business calendar the policy counts business time on. */
        calendar: z.string().trim().min(1).max(200),
        targets: slaTargetsSchema,
      }),
    )
    .min(1),
});
export type SlaPolicyFile = z.infer<typeof slaPolicyFileSchema>;
