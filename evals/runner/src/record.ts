import { schema, type Database } from '@watchtower/db';
import { createRedactor } from '@watchtower/ai';
import { recordReplayResult, replaySetFor, type ReplaySet } from '@watchtower/domain';
import { and, eq } from 'drizzle-orm';

import { exportReplay } from './replay.js';
import {
  evaluateRedaction,
  redactionGate,
  type RedactionCase,
  type RedactFn,
} from './redaction-eval.js';
import { runCase } from './run.js';
import { EvalSetupError, type Rig } from './rig.js';

/**
 * Records the replay of the combination in force for an intent (T-306g, ADR-025 section 7 C-4). The set is the
 * one the gate reads: drafter and grader model aliases from the settings (what `ai_run.model` will hold), the
 * latest version of the two prompts, and the intent's published procedure version (`replaySetFor`, the same
 * lookup the gate's facts use). The run is the replay of recent resolved tickets of the intent (never a seeded
 * one, redacted by `exportReplay`) through the drafter and the grader, plus the redaction eval. The result goes
 * through `record_replay_result()`, which the database lets only a person who holds `ai.autonomy.promote` call
 * and which never marks a mock run, an empty run or a run with a violation as passed.
 *
 * Nothing here returns or prints ticket text: the outcome is numbers and ids.
 */

export interface RecordOptions {
  readonly database: Database;
  readonly rig: Rig;
  readonly intentKey: string;
  /** Email of the person who records (must hold `ai.autonomy.promote`; the database checks). */
  readonly actorEmail: string;
  readonly days: number;
  readonly limit: number;
  readonly dryRun: boolean;
  readonly redactionCorpus: readonly RedactionCase[];
  readonly redactionGate?: { readonly minRecall: number; readonly maxFalsePositive: number };
}

export interface RecordOutcome {
  readonly intentKey: string;
  readonly set: ReplaySet;
  readonly tickets: number;
  /** Drafter and grader cases that ran. */
  readonly caseCount: number;
  /** Cases of those where an answer broke a check (language, review flag, grader invariant) or did not come. */
  readonly violations: number;
  readonly redactionPassed: boolean;
  readonly mock: boolean;
  readonly calls: number;
  /** What the database will say: false for a mock run whatever the rest is. */
  readonly wouldPass: boolean;
  /** The id of the stored row; null for `--dry-run`. */
  readonly recordedId: string | null;
}

export async function recordReplay(options: RecordOptions): Promise<RecordOutcome> {
  const db = options.database.db;
  const [intent] = await db
    .select({ id: schema.intent.id })
    .from(schema.intent)
    .where(and(eq(schema.intent.key, options.intentKey), eq(schema.intent.isActive, true)))
    .limit(1);
  if (intent === undefined) throw new EvalSetupError('no active intent with that key');
  const [actor] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.email, options.actorEmail), eq(schema.users.status, 'active')))
    .limit(1);
  if (actor === undefined) throw new EvalSetupError('no active user with that email (--as)');

  const rig = options.rig;
  const set = await replaySetFor(db, {
    intentId: intent.id,
    drafterModel: rig.modelOf('drafter'),
    graderModel: rig.modelOf('grader'),
    drafterPromptVersion: rig.prompts.latest('drafter').ref.version,
    graderPromptVersion: rig.prompts.latest('grader').ref.version,
  });

  const exported = await exportReplay({
    database: options.database,
    days: options.days,
    limit: options.limit,
    intentKey: options.intentKey,
  });
  // The classifier labels are what the ticket ended with (not a judgement): they are not a policy check.
  const cases = exported.cases.filter(
    (item) => item.agent === 'drafter' || item.agent === 'grader',
  );
  let violations = 0;
  for (const item of cases) {
    const result = await runCase(rig, item, 'replay', {});
    // A call the budget guard refused says nothing about the model: stop instead of counting a violation.
    if (result.status === 'skipped') {
      throw new EvalSetupError(
        `the call budget stopped the replay after ${String(rig.guard.calls())} call(s) (${result.reason ?? 'skipped'}): raise --max-calls`,
      );
    }
    if (!result.pass) violations += 1;
  }

  const redactor: RedactFn = (text, names) =>
    createRedactor({ names: () => names })
      .session({ scope: 'eval:redaction' })
      .redact(text);
  const redaction = evaluateRedaction('createRedactor()', options.redactionCorpus, redactor);
  const redactionPassed =
    redactionGate(redaction, options.redactionGate ?? { minRecall: 1, maxFalsePositive: 0.02 })
      .length === 0;

  const mock = rig.provider === 'mock';
  const wouldPass = cases.length >= 1 && violations === 0 && redactionPassed && !mock;
  const recordedId = options.dryRun
    ? null
    : await recordReplayResult(db, actor.id, {
        intentId: intent.id,
        source: 'eval',
        drafterModel: set.drafterModel,
        graderModel: set.graderModel,
        drafterPromptVersion: set.drafterPromptVersion,
        graderPromptVersion: set.graderPromptVersion,
        procedureVersionId: set.procedureVersionId,
        caseCount: cases.length,
        violations,
        redactionPassed,
        mock,
      });
  return {
    intentKey: options.intentKey,
    set,
    tickets: exported.tickets,
    caseCount: cases.length,
    violations,
    redactionPassed,
    mock,
    calls: rig.guard.calls(),
    wouldPass,
    recordedId,
  };
}

/** Numbers, ids, model aliases and prompt versions only. */
export function formatRecord(outcome: RecordOutcome): string {
  const { set } = outcome;
  return [
    `record: intent ${outcome.intentKey}${outcome.recordedId === null ? ' (dry run, nothing stored)' : ''}`,
    `  set: drafter ${set.drafterModel} v${String(set.drafterPromptVersion)}, grader ${set.graderModel} v${String(set.graderPromptVersion)}, procedure version ${set.procedureVersionId ?? 'none'}`,
    `  tickets ${String(outcome.tickets)}, cases ${String(outcome.caseCount)}, violations ${String(outcome.violations)}, redaction eval ${outcome.redactionPassed ? 'passed' : 'FAILED'}, model calls ${String(outcome.calls)}`,
    `  provider ${outcome.mock ? 'mock (can never pass)' : 'real'} -> passed ${outcome.wouldPass ? 'yes' : 'no'}`,
    ...(outcome.recordedId === null ? [] : [`  stored: ${outcome.recordedId}`]),
  ].join('\n');
}
