/**
 * Roster planner (T-305e, PRD R-7.2): this feature's audit actions and the HTTP contract of the plan endpoints.
 * The solver itself is `../roster-solver.ts` (pure, deterministic). A plan is a draft until a lead or head applies
 * it; the AI only explains a plan, it never changes one (N3 spirit: nothing reaches the roster without a person).
 */
import { z } from 'zod';

import { calendarDateSchema } from '../sla.js';

export const ROSTER_PLAN_AUDIT_ACTIONS = {
  rosterPlanCreate: 'roster.plan_create',
  rosterPlanEdit: 'roster.plan_edit',
  rosterPlanExplain: 'roster.plan_explain',
  rosterPlanApply: 'roster.plan_apply',
  rosterPlanDiscard: 'roster.plan_discard',
} as const satisfies Record<string, string>;

export const ROSTER_PLAN_TICKET_EVENTS = {} as const satisfies Record<string, string>;
export const ROSTER_PLAN_QUEUES = {} as const satisfies Record<string, string>;

export const ROSTER_PLAN_LIMITS = {
  maxPeople: 60,
  maxCoverageRules: 80,
  maxEditEntries: 200,
  /** A planned shift that starts within this many minutes of now (or earlier) counts as started. */
  startedGraceMinutes: 60,
  /** Tickets one person is expected to handle in a shift when coverage is guessed from volume `[ASSUMED]`. */
  defaultTicketsPerPersonPerShift: 15,
  maxHeadCount: 20,
  historyWeeks: 4,
  volumeDays: 28,
} as const;

export const ROSTER_PLAN_STATUSES = ['draft', 'applied', 'discarded'] as const;
export const rosterPlanStatusSchema = z.enum(ROSTER_PLAN_STATUSES);
export type RosterPlanStatus = z.infer<typeof rosterPlanStatusSchema>;

const dateSchema = calendarDateSchema;

export const rosterRulesSchema = z.object({
  minRestHours: z.number().int().min(0).max(24),
  maxShiftsPerWeek: z.number().int().min(1).max(14),
  maxConsecutiveDays: z.number().int().min(1).max(14),
  maxConsecutiveNights: z.number().int().min(1).max(14),
});
export type RosterRulesBody = z.infer<typeof rosterRulesSchema>;

export const coverageRuleSchema = z.object({
  shiftId: z.uuid(),
  /** 0 = Sunday to 6 = Saturday; empty = every day. */
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  required: z.number().int().min(0).max(ROSTER_PLAN_LIMITS.maxHeadCount),
  queueId: z.uuid().nullable().default(null),
});
export type CoverageRuleBody = z.infer<typeof coverageRuleSchema>;

export const unavailableInputSchema = z.object({
  userId: z.uuid(),
  dates: z.array(dateSchema).min(1).max(31),
});

export const rosterAssignmentSchema = z.object({
  userId: z.uuid(),
  shiftId: z.uuid(),
  workDate: dateSchema,
});
export type RosterAssignmentBody = z.infer<typeof rosterAssignmentSchema>;

export const createRosterPlanSchema = z.object({
  /** First local date of the week to plan; the plan covers seven days from it. */
  weekStart: dateSchema,
  /** Who may be rostered. Default: every active agent and lead. */
  userIds: z.array(z.uuid()).min(1).max(ROSTER_PLAN_LIMITS.maxPeople).optional(),
  rules: rosterRulesSchema.partial().optional(),
  /** Default: guessed from the tickets of the past weeks. */
  coverage: z.array(coverageRuleSchema).max(ROSTER_PLAN_LIMITS.maxCoverageRules).optional(),
  /** Leave and days off (also from the people who are not in `userIds` it is ignored). */
  unavailable: z.array(unavailableInputSchema).max(ROSTER_PLAN_LIMITS.maxPeople).optional(),
  holidays: z.array(dateSchema).max(14).optional(),
});
export type CreateRosterPlan = z.infer<typeof createRosterPlanSchema>;

export const rosterPlanDefaultsQuerySchema = z.object({ weekStart: dateSchema });
export type RosterPlanDefaultsQuery = z.infer<typeof rosterPlanDefaultsQuerySchema>;

const failureSchema = z.object({
  code: z.string(),
  userId: z.string().nullable(),
  shiftId: z.string().nullable(),
  workDate: z.string().nullable(),
  message: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.string()])),
});

export const rosterReportSchema = z.object({
  hardOk: z.boolean(),
  coverageOk: z.boolean(),
  items: z.array(
    z.object({
      id: z.enum([
        'unavailable',
        'rest',
        'max_shifts_week',
        'max_consecutive_days',
        'max_consecutive_nights',
        'coverage',
        'fairness_nights',
        'fairness_heavy_days',
      ]),
      kind: z.enum(['hard', 'coverage', 'fairness']),
      status: z.enum(['pass', 'fail']),
      message: z.string(),
      failures: z.array(failureSchema),
    }),
  ),
  loads: z.array(
    z.object({
      userId: z.string(),
      shifts: z.number(),
      nights: z.number(),
      heavyDays: z.number(),
    }),
  ),
});
export type RosterReportBody = z.infer<typeof rosterReportSchema>;

const personSchema = z.object({
  id: z.string(),
  name: z.string(),
  queueIds: z.array(z.string()),
  unavailable: z.array(z.string()),
});

const shiftSchema = z.object({
  id: z.string(),
  name: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  onCall: z.boolean(),
});

/** What the plan was made from (also what a re-check uses, so a hand edit is judged by the same rules). */
export const rosterPlanInputsSchema = z.object({
  weekStart: z.string(),
  people: z.array(personSchema),
  shifts: z.array(shiftSchema),
  rules: rosterRulesSchema,
  coverage: z.array(coverageRuleSchema),
  /** `suggested`: guessed from ticket volume `[ASSUMED]`; `given`: the lead's own. */
  coverageSource: z.enum(['suggested', 'given']),
  fixed: z.array(rosterAssignmentSchema),
  history: z.record(z.string(), z.object({ nights: z.number(), heavyDays: z.number() })),
  holidays: z.array(z.string()),
});
export type RosterPlanInputs = z.infer<typeof rosterPlanInputsSchema>;

export const rosterPlanEntrySchema = z.object({
  userId: z.uuid(),
  userName: z.string(),
  shiftId: z.uuid(),
  shiftName: z.string(),
  workDate: z.string(),
  /** Already stands in the roster (started, so the plan cannot move it). */
  locked: z.boolean(),
});

export const rosterPlanExplanationSchema = z.object({
  text: z.string(),
  locale: z.enum(['th', 'en']),
  promptVersion: z.number().int(),
  /** A hand edit of the plan clears the explanation, so this always describes the plan as it is. */
  createdAt: z.iso.datetime(),
});

export const rosterPlanDiffSchema = z.object({
  /** In the plan, not in the roster yet. */
  add: z.number().int(),
  /** In the roster for a shift that has not started, not in the plan: applying removes it. */
  remove: z.number().int(),
  keep: z.number().int(),
  /** In the roster and started: untouched. */
  locked: z.number().int(),
  /** Planned shifts that have started by now: applying is refused while there are any. */
  started: z.number().int(),
});

export const rosterPlanSchema = z.object({
  id: z.uuid(),
  weekStart: z.string(),
  status: rosterPlanStatusSchema,
  timezone: z.string(),
  entries: z.array(rosterPlanEntrySchema),
  inputs: rosterPlanInputsSchema,
  report: rosterReportSchema,
  /** `complete`: coverage met. `no_solution`: proven that no plan meets it. `unproven`: the search stopped early. */
  solver: z.object({
    status: z.enum(['complete', 'no_solution', 'unproven']),
    nodes: z.number().int(),
  }),
  explanation: rosterPlanExplanationSchema.nullable(),
  diff: rosterPlanDiffSchema,
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});
export type RosterPlan = z.infer<typeof rosterPlanSchema>;

export const rosterPlanSummarySchema = z.object({
  id: z.uuid(),
  weekStart: z.string(),
  status: rosterPlanStatusSchema,
  entryCount: z.number().int(),
  createdAt: z.iso.datetime(),
  appliedAt: z.iso.datetime().nullable(),
});
export const rosterPlanListSchema = z.object({ plans: z.array(rosterPlanSummarySchema) });
export type RosterPlanList = z.infer<typeof rosterPlanListSchema>;

export const rosterPlanDefaultsSchema = z.object({
  weekStart: z.string(),
  timezone: z.string(),
  people: z.array(personSchema.extend({ role: z.string() })),
  queues: z.array(z.object({ id: z.uuid(), name: z.string() })),
  shifts: z.array(shiftSchema),
  rules: rosterRulesSchema,
  coverage: z.array(coverageRuleSchema),
  coverageSource: z.literal('suggested'),
  ticketsPerPersonPerShift: z.number().int(),
});
export type RosterPlanDefaults = z.infer<typeof rosterPlanDefaultsSchema>;

export const editRosterPlanSchema = z
  .object({
    add: z.array(rosterAssignmentSchema).max(ROSTER_PLAN_LIMITS.maxEditEntries).default([]),
    remove: z.array(rosterAssignmentSchema).max(ROSTER_PLAN_LIMITS.maxEditEntries).default([]),
  })
  .refine((value) => value.add.length + value.remove.length > 0, { message: 'nothing to change' });
export type EditRosterPlan = z.infer<typeof editRosterPlanSchema>;

export const explainRosterPlanSchema = z.object({ locale: z.enum(['th', 'en']).default('en') });
export type ExplainRosterPlan = z.infer<typeof explainRosterPlanSchema>;

export const applyRosterPlanSchema = z.object({
  /** Apply although some shift has fewer people than it needs. A broken hard rule is never accepted. */
  acceptShortfall: z.boolean().default(false),
});
export type ApplyRosterPlan = z.infer<typeof applyRosterPlanSchema>;

export const applyRosterPlanResultSchema = z.object({
  plan: rosterPlanSchema,
  added: z.number().int(),
  removed: z.number().int(),
});
export type ApplyRosterPlanResult = z.infer<typeof applyRosterPlanResultSchema>;
