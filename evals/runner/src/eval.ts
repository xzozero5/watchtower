import { PROMPT_OF_AGENT, type EvalAgent, type LoadedCase } from './case.js';
import { runCase, type CaseResult } from './run.js';
import type { Rig } from './rig.js';

export interface EvalRunOptions {
  readonly cases: readonly LoadedCase[];
  readonly rig: Rig;
  /** Only these agents; all when empty. */
  readonly agents?: readonly EvalAgent[] | undefined;
  /** Prompt id to version. A prompt not named here runs at its latest version. */
  readonly pins?: Readonly<Record<string, number>> | undefined;
  /** Run every case at every version of its prompt, to compare versions in one report. */
  readonly allVersions?: boolean | undefined;
  /** Called after each result, for progress. */
  readonly onResult?: ((result: CaseResult) => void) | undefined;
}

/**
 * Runs the cases one after another (one at a time keeps the call budget and the order of the report
 * easy to follow). With `allVersions`, each case runs once per version of its agent's prompt, so the
 * report holds a pass rate per prompt version (PRD 6.5 step 3).
 */
export async function runEval(options: EvalRunOptions): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const wanted = options.agents ?? [];
  for (const loaded of options.cases) {
    if (wanted.length > 0 && !wanted.includes(loaded.case.agent)) continue;
    const promptId = PROMPT_OF_AGENT[loaded.case.agent];
    const versions =
      options.allVersions === true
        ? options.rig.prompts
            .list()
            .filter((prompt) => prompt.id === promptId)
            .map((prompt) => prompt.version)
            .toSorted((a, b) => a - b)
        : [undefined];
    for (const version of versions) {
      const pins = { ...options.pins, ...(version === undefined ? {} : { [promptId]: version }) };
      const result = await runCase(options.rig, loaded.case, loaded.source, pins);
      results.push(result);
      options.onResult?.(result);
    }
  }
  return results;
}
