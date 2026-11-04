import { schema, type Database } from '@watchtower/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { ReadExecutor } from '../types.js';

/**
 * Replay evidence (T-306e C-4, ADR-025 section 7). A change of drafter model, grader model, prompt version or
 * procedure version is only safe once the eval set (or a simulation of the procedure) has been replayed on the
 * new combination and passed. The result is stored in `ai_replay_result` (0109); the gate reads the latest row of
 * the combination in force, so a missing or failed replay suspends auto-send (`replay_missing`). It never rolls
 * an intent back: nothing it says changes a stage.
 */

/** The combination a replay is about. Models are the aliases of the settings (`ai_run.model`). */
export interface ReplaySet {
  readonly intentId: string;
  readonly drafterModel: string;
  readonly graderModel: string;
  readonly drafterPromptVersion: number;
  readonly graderPromptVersion: number;
  /** The intent's published procedure version, or null when it has none. */
  readonly procedureVersionId: string | null;
  /** The `steps_hash` of that version (the simulation must be of the same steps). */
  readonly procedureStepsHash: string | null;
}

/**
 * True when the latest replay of exactly this combination passed and, when the intent has a published procedure,
 * the latest simulation of that version passed on the same steps. Anything else (no row, a later failed row, a
 * different combination) is false.
 */
export async function replayPassedForSet(db: ReadExecutor, set: ReplaySet): Promise<boolean> {
  const [latest] = await db
    .select({ passed: schema.aiReplayResult.passed, mock: schema.aiReplayResult.mock })
    .from(schema.aiReplayResult)
    .where(
      and(
        eq(schema.aiReplayResult.intentId, set.intentId),
        eq(schema.aiReplayResult.drafterModel, set.drafterModel),
        eq(schema.aiReplayResult.graderModel, set.graderModel),
        eq(schema.aiReplayResult.drafterPromptVersion, set.drafterPromptVersion),
        eq(schema.aiReplayResult.graderPromptVersion, set.graderPromptVersion),
        set.procedureVersionId === null
          ? isNull(schema.aiReplayResult.procedureVersionId)
          : eq(schema.aiReplayResult.procedureVersionId, set.procedureVersionId),
      ),
    )
    .orderBy(desc(schema.aiReplayResult.createdAt), desc(schema.aiReplayResult.id))
    .limit(1);
  if (latest === undefined || !latest.passed || latest.mock) return false;
  if (set.procedureVersionId === null) return true;
  const [simulation] = await db
    .select({
      passed: schema.procedureSimulation.passed,
      hash: schema.procedureSimulation.stepsHash,
    })
    .from(schema.procedureSimulation)
    .where(eq(schema.procedureSimulation.procedureVersionId, set.procedureVersionId))
    .orderBy(desc(schema.procedureSimulation.createdAt), desc(schema.procedureSimulation.id))
    .limit(1);
  return (
    simulation !== undefined &&
    simulation.passed &&
    set.procedureStepsHash !== null &&
    simulation.hash === set.procedureStepsHash
  );
}

export interface NewReplayResult {
  readonly intentId: string;
  readonly source: 'eval' | 'simulation';
  readonly drafterModel: string;
  readonly graderModel: string;
  readonly drafterPromptVersion: number;
  readonly graderPromptVersion: number;
  readonly procedureVersionId: string | null;
  readonly caseCount: number;
  /** Policy or data-leak violations the replay found. */
  readonly violations: number;
  /** The redaction eval of the same run passed. */
  readonly redactionPassed: boolean;
  /** The replay ran on the mock provider: it can never pass. */
  readonly mock: boolean;
}

/**
 * Stores one replay outcome through `record_replay_result()`. `actor` is a person who holds
 * `ai.autonomy.promote` (the function checks it); the application role cannot insert into the table itself.
 * `passed` is computed by the database.
 */
export async function recordReplayResult(
  db: Pick<Database['db'], 'execute'>,
  actor: string,
  result: NewReplayResult,
): Promise<string> {
  const rows = await db.execute<{ id: string } & Record<string, unknown>>(sql`
    SELECT public.record_replay_result(
      ${actor}::uuid, ${result.intentId}::uuid, ${result.source}, ${result.drafterModel}, ${result.graderModel},
      ${result.drafterPromptVersion}::int, ${result.graderPromptVersion}::int, ${result.procedureVersionId}::uuid,
      ${result.caseCount}::int, ${result.violations}::int, ${result.redactionPassed}::boolean, ${result.mock}::boolean
    ) AS id
  `);
  const id = rows.rows[0]?.id;
  if (typeof id !== 'string') throw new Error('record_replay_result returned no id');
  return id;
}
