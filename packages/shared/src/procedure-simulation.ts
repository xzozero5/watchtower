/**
 * Simulation of a procedure version before it is published (T-303d, ADR-026 section 6): the numbers that
 * decide a pass, the metrics stored in `procedure_simulation.metrics`, the queue job and the HTTP contract of
 * `POST|GET /v1/intents/:id/procedure/versions/:versionId/simulat(e|ion)`. Pure: no I/O.
 */
import { z } from 'zod';

import { stepIdSchema } from './procedure.js';

/** The tag a `require_human` step puts on a ticket (the queue shows it; T-304 and the auto-send gate read the event). */
export const PROCEDURE_REQUIRE_HUMAN_TAG = 'procedure:require-human';

/** `[ASSUMED]` numbers of ADR-026 section 6. */
export const PROCEDURE_SIMULATION = {
  /** Resolved tickets of the intent, newest first. */
  caseCount: 30,
  /** How many points (0..100) the mean edit distance to the person's reply may get worse against the version live now. */
  maxEditDistanceWorsePoints: 5,
  /** A share of cases the models could not answer (invalid output) above which the run does not pass. */
  maxFailedShare: 0.1,
  /** The `simulation` bucket of the tool budget: lower than a live investigation so a simulation cannot starve one. */
  toolBudgets: { perRun: 12, perTicketPerHour: 40, perToolPerMinute: 10 },
  /** Tool calls one simulation may make over all its cases and both variants. */
  maxToolCalls: 600,
} as const;

export const PROCEDURE_SIMULATION_FAIL_REASONS = [
  'policy_violation',
  'disclosure_leak',
  'more_uncited',
  'edit_distance_worse',
  'step_never_worked',
  'too_many_failed',
  'no_cases',
] as const;
export type ProcedureSimulationFailReason = (typeof PROCEDURE_SIMULATION_FAIL_REASONS)[number];

const simulationSideSchema = z.object({
  /** Mean of the normalised edit distance between the draft and the person's reply, 0 (same) to 100. */
  editDistance: z.number().min(0).max(100),
  uncitedClaims: z.number().int().nonnegative(),
  /** Cases a draft was written for. */
  drafted: z.number().int().nonnegative(),
});
export type ProcedureSimulationSide = z.infer<typeof simulationSideSchema>;

export const procedureSimulationCaseSchema = z.object({
  /** The ticket of the case (a uuid, or a fixture id), so a lead can open it. */
  ticketId: z.string().max(100),
  seeded: z.boolean(),
  ok: z.boolean(),
  editDistance: z.number().min(0).max(100).nullable(),
  baselineEditDistance: z.number().min(0).max(100).nullable(),
  uncitedClaims: z.number().int().nonnegative(),
  violations: z.number().int().nonnegative(),
  disclosureLeaks: z.number().int().nonnegative(),
});
export type ProcedureSimulationCase = z.infer<typeof procedureSimulationCaseSchema>;

export const procedureSimulationMetricsSchema = z.object({
  /** `instance`: tickets and tools of this instance; `fixture`: made-up cases (CI). */
  mode: z.enum(['instance', 'fixture']),
  caseCount: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
  seededCases: z.number().int().nonnegative(),
  candidate: simulationSideSchema.extend({
    violations: z.number().int().nonnegative(),
    disclosureLeaks: z.number().int().nonnegative(),
  }),
  /** The version live now (or the default runbook). */
  baseline: simulationSideSchema.nullable(),
  baselineVersionId: z.uuid().nullable(),
  /** Tool steps that ran in no case, or failed in every case that ran them. */
  deadSteps: z.array(stepIdSchema).max(20),
  toolCalls: z.number().int().nonnegative(),
  failReasons: z.array(z.enum(PROCEDURE_SIMULATION_FAIL_REASONS)).max(10),
  cases: z.array(procedureSimulationCaseSchema).max(100),
});
export type ProcedureSimulationMetrics = z.infer<typeof procedureSimulationMetricsSchema>;

/** One `procedure-simulate` job: the ids only; the worker loads the version and the tickets. */
export const procedureSimulateJobSchema = z.object({
  versionId: z.uuid(),
  requestedBy: z.uuid(),
});
export type ProcedureSimulateJob = z.infer<typeof procedureSimulateJobSchema>;

export const PROCEDURE_SIMULATE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** What `POST .../simulate` answers: the job is queued, the result comes with `GET .../simulation`. */
export const procedureSimulateQueuedSchema = z.object({
  versionId: z.uuid(),
  queued: z.literal(true),
});
export type ProcedureSimulateQueued = z.infer<typeof procedureSimulateQueuedSchema>;

export const procedureSimulationResultSchema = z.object({
  id: z.uuid(),
  versionId: z.uuid(),
  stepsHash: z.string().regex(/^[0-9a-f]{64}$/),
  passed: z.boolean(),
  seedOnly: z.boolean(),
  caseCount: z.number().int().nonnegative(),
  metrics: procedureSimulationMetricsSchema,
  ranBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type ProcedureSimulationResult = z.infer<typeof procedureSimulationResultSchema>;

/** `simulation` is null until a run has finished. */
export const procedureSimulationAnswerSchema = z.object({
  versionId: z.uuid(),
  simulation: procedureSimulationResultSchema.nullable(),
});
export type ProcedureSimulationAnswer = z.infer<typeof procedureSimulationAnswerSchema>;

/**
 * The pass rule of ADR-026 section 6, as code: no policy violation, no disclosure leak, no more uncited claims
 * than the version live now, an edit distance not worse by more than `maxEditDistanceWorsePoints`, every tool
 * step worked at least once, and not too many cases the models could not answer. Pure and total.
 */
export function judgeSimulation(
  metrics: Omit<ProcedureSimulationMetrics, 'failReasons'>,
): ProcedureSimulationFailReason[] {
  const reasons: ProcedureSimulationFailReason[] = [];
  if (metrics.caseCount === 0) return ['no_cases'];
  if (metrics.candidate.violations > 0) reasons.push('policy_violation');
  if (metrics.candidate.disclosureLeaks > 0) reasons.push('disclosure_leak');
  if (metrics.baseline !== null) {
    if (metrics.candidate.uncitedClaims > metrics.baseline.uncitedClaims)
      reasons.push('more_uncited');
    if (
      metrics.candidate.editDistance - metrics.baseline.editDistance >
      PROCEDURE_SIMULATION.maxEditDistanceWorsePoints
    ) {
      reasons.push('edit_distance_worse');
    }
  }
  if (metrics.deadSteps.length > 0) reasons.push('step_never_worked');
  if (metrics.failedCases / metrics.caseCount > PROCEDURE_SIMULATION.maxFailedShare) {
    reasons.push('too_many_failed');
  }
  return reasons;
}
