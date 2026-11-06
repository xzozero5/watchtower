import { z } from 'zod';

import type { CaseResult } from './run.js';

export interface SummaryRow {
  readonly agent: string;
  readonly promptId: string;
  readonly promptVersion: number;
  readonly promptHash: string;
  readonly total: number;
  readonly passed: number;
  /** passed / total, 0 when there were no cases. */
  readonly passRate: number;
  /** Cases where the agent did not answer (guard, budget, unusable output). Counted as failures. */
  readonly noAnswer: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly citationRecall?: number | null;
  readonly uncitedClaims?: number;
}

export interface EvalReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly provider: string;
  readonly results: readonly CaseResult[];
  readonly summary: readonly SummaryRow[];
}

/** One row per agent and prompt version: how often the answers passed their checks. */
export function summarize(results: readonly CaseResult[]): SummaryRow[] {
  const rows = new Map<string, CaseResult[]>();
  for (const result of results) {
    const key = `${result.agent}@${String(result.promptVersion)}`;
    rows.set(key, [...(rows.get(key) ?? []), result]);
  }
  return [...rows.values()].map((group) => {
    const first = group[0] as CaseResult;
    const priced = group.filter((result) => result.costUsd !== null);
    const passed = group.filter((result) => result.pass).length;
    const citations = group.flatMap((result) => result.citationMetrics ?? []);
    const requiredRefs = citations.reduce((total, item) => total + item.requiredRefs, 0);
    const matchedRefs = citations.reduce((total, item) => total + item.matchedRefs, 0);
    return {
      agent: first.agent,
      promptId: first.promptId,
      promptVersion: first.promptVersion,
      promptHash: first.promptHash,
      ...(citations.length === 0
        ? {}
        : {
            citationRecall: requiredRefs === 0 ? null : matchedRefs / requiredRefs,
            uncitedClaims: citations.reduce((total, item) => total + item.uncitedClaims, 0),
          }),
      total: group.length,
      passed,
      passRate: group.length === 0 ? 0 : passed / group.length,
      noAnswer: group.filter((result) => result.status !== 'ok').length,
      inputTokens: group.reduce((n, result) => n + result.inputTokens, 0),
      outputTokens: group.reduce((n, result) => n + result.outputTokens, 0),
      costUsd:
        priced.length === 0 ? null : priced.reduce((n, result) => n + (result.costUsd ?? 0), 0),
    };
  });
}

export function buildReport(
  provider: string,
  results: readonly CaseResult[],
  now: Date = new Date(),
): EvalReport {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    provider,
    results,
    summary: summarize(results),
  };
}

/** Only what comparing needs: a baseline written by an older runner still loads. */
const baselineSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      promptVersion: z.number(),
      pass: z.boolean(),
    }),
  ),
  summary: z.array(
    z.object({
      agent: z.string(),
      promptVersion: z.number(),
      passRate: z.number(),
    }),
  ),
});

export interface Regression {
  readonly agent: string;
  readonly promptVersion: number;
  /** Cases that passed in the baseline and fail now. */
  readonly cases: readonly string[];
  readonly baselineRate: number;
  readonly currentRate: number;
}

export interface Comparison {
  readonly regressions: readonly Regression[];
  /** Cases that failed in the baseline and pass now. */
  readonly fixed: readonly string[];
  /** Rows of the current run with nothing to compare to in the baseline. */
  readonly notInBaseline: readonly string[];
}

export function parseBaseline(raw: unknown): z.infer<typeof baselineSchema> {
  return baselineSchema.parse(raw);
}

/**
 * Compares a run with an earlier report of the same prompt version (a regression is a case that used
 * to pass and now fails, or a pass rate that fell). A prompt version the baseline has never seen is
 * listed, not judged: a new version has nothing to regress from.
 */
export function compareReports(
  current: EvalReport,
  baseline: z.infer<typeof baselineSchema>,
): Comparison {
  const was = new Map(
    baseline.results.map((result) => [
      `${result.agent}@${String(result.promptVersion)}:${result.id}`,
      result.pass,
    ]),
  );
  const regressions: Regression[] = [];
  const fixed: string[] = [];
  const notInBaseline: string[] = [];
  for (const row of current.summary) {
    const key = `${row.agent}@${String(row.promptVersion)}`;
    const before = baseline.summary.find(
      (item) => item.agent === row.agent && item.promptVersion === row.promptVersion,
    );
    if (before === undefined) {
      notInBaseline.push(key);
      continue;
    }
    const cases: string[] = [];
    for (const result of current.results) {
      if (result.agent !== row.agent || result.promptVersion !== row.promptVersion) continue;
      const earlier = was.get(`${key}:${result.id}`);
      if (earlier === true && !result.pass) cases.push(result.id);
      if (earlier === false && result.pass) fixed.push(`${key}:${result.id}`);
    }
    if (cases.length > 0 || row.passRate < before.passRate) {
      regressions.push({
        agent: row.agent,
        promptVersion: row.promptVersion,
        cases,
        baselineRate: before.passRate,
        currentRate: row.passRate,
      });
    }
  }
  return { regressions, fixed, notInBaseline };
}

const pct = (rate: number): string => `${(rate * 100).toFixed(0)}%`;

/** A plain table for the terminal. No ticket text: ids, counts and the reasons of failed checks. */
export function formatReport(report: EvalReport, comparison?: Comparison): string {
  const lines: string[] = [
    `eval: provider ${report.provider}, ${String(report.results.length)} case(s)`,
    '',
    'agent        prompt  cases  pass   rate  no-answer  tokens(in/out)   cost',
  ];
  for (const row of report.summary) {
    lines.push(
      [
        row.agent.padEnd(12),
        `v${String(row.promptVersion)}`.padEnd(7),
        String(row.total).padStart(5),
        String(row.passed).padStart(5),
        pct(row.passRate).padStart(6),
        String(row.noAnswer).padStart(10),
        `${String(row.inputTokens)}/${String(row.outputTokens)}`.padStart(15),
        row.costUsd === null ? 'unknown'.padStart(8) : `$${row.costUsd.toFixed(4)}`.padStart(8),
      ].join(' '),
    );
  }
  for (const row of report.summary)
    if (row.citationRecall !== undefined) {
      lines.push(
        `  ${row.agent}: citation recall ${row.citationRecall === null ? 'n/a (no required refs)' : pct(row.citationRecall)}, uncited ${String(row.uncitedClaims ?? 0)}`,
      );
    }
  const failed = report.results.filter((result) => !result.pass);
  if (failed.length > 0) {
    lines.push('', 'failed:');
    for (const result of failed) {
      const why = result.checks
        .filter((check) => !check.pass)
        .map((check) =>
          check.detail === undefined ? check.name : `${check.name} (${check.detail})`,
        )
        .join('; ');
      lines.push(`  ${result.agent}@v${String(result.promptVersion)} ${result.id}: ${why}`);
    }
  }
  if (comparison !== undefined) {
    lines.push('');
    if (comparison.regressions.length === 0) lines.push('no regression against the baseline');
    for (const item of comparison.regressions) {
      lines.push(
        `REGRESSION ${item.agent}@v${String(item.promptVersion)}: ${pct(item.baselineRate)} -> ${pct(item.currentRate)}` +
          (item.cases.length > 0 ? `, now failing: ${item.cases.join(', ')}` : ''),
      );
    }
    if (comparison.fixed.length > 0) lines.push(`fixed: ${comparison.fixed.join(', ')}`);
    if (comparison.notInBaseline.length > 0) {
      lines.push(`not in the baseline: ${comparison.notInBaseline.join(', ')}`);
    }
  }
  return lines.join('\n');
}
