import { z } from 'zod';

/**
 * Deterministic eval of the redactor (T-302e, PRD section 6.6 / N4). No model, no network: each case
 * is a made-up text, the strings in it that must not reach a model (`redact`), and the strings that
 * must still be there afterwards (`keep`). Recall = the share of `redact` strings that are gone;
 * false-positive rate = the share of `keep` strings that were destroyed.
 *
 * A case with `known: true` is a documented gap of the redactor (for example a name with no cue and
 * no dictionary entry, ADR-008). It is counted and shown but does not gate the exit code, so the
 * number a later detector (T-153) has to move stays visible.
 */

export const REDACTION_CATEGORIES = [
  'name_dictionary',
  'name_cue',
  'name_nocue',
  'email',
  'phone',
  'national_id',
  'card',
  'passport',
  'csat_link',
  'keep',
] as const;
export type RedactionCategory = (typeof REDACTION_CATEGORIES)[number];

export const redactionCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  category: z.enum(REDACTION_CATEGORIES),
  lang: z.enum(['th', 'en']),
  text: z.string().min(1).max(8000),
  /** Names the system already knows (the dictionary the redactor gets). */
  names: z.array(z.string().min(1)).optional(),
  redact: z.array(z.string().min(1)).default([]),
  keep: z.array(z.string().min(1)).default([]),
  known: z.boolean().default(false),
});
export type RedactionCase = z.infer<typeof redactionCaseSchema>;

export const redactionCorpusSchema = z.object({
  note: z.string().optional(),
  cases: z.array(redactionCaseSchema).min(1),
});

/** What the eval calls: text in, redacted text out. `names` is the dictionary of the case. */
export type RedactFn = (text: string, names: readonly string[]) => string;

const THAI_DIGIT_ZERO = 0x0e50;
const toAsciiDigits = (value: string): string =>
  value.replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - THAI_DIGIT_ZERO));
const digitsOf = (value: string): string => toAsciiDigits(value).replace(/\D/g, '');

const NUMERIC: ReadonlySet<RedactionCategory> = new Set(['phone', 'national_id', 'card']);
const WORDS: ReadonlySet<RedactionCategory> = new Set([
  'name_dictionary',
  'name_cue',
  'name_nocue',
]);

/**
 * Did the value survive in the output? Numbers are compared by their digits (so "081-234-5678" is
 * still a leak if only the dashes were dropped); names by their words (a leaked given name is a leak
 * even when the family name was caught); everything else as an exact substring.
 */
export function leaks(category: RedactionCategory, value: string, output: string): boolean {
  if (NUMERIC.has(category)) {
    const digits = digitsOf(value);
    // Placeholders end in an index ("[PHONE_1]"); only a long run of the value's digits is a leak.
    return digits.length >= 6 && digitsOf(output).includes(digits);
  }
  if (WORDS.has(category)) {
    const lower = output.toLowerCase();
    return value
      .split(/\s+/)
      .filter((word) => word.length >= 2)
      .some((word) => lower.includes(word.toLowerCase()));
  }
  return output.includes(value);
}

export interface CaseOutcome {
  readonly id: string;
  readonly category: RedactionCategory;
  readonly known: boolean;
  readonly leaked: readonly string[];
  readonly destroyed: readonly string[];
  readonly redactItems: number;
  readonly keepItems: number;
  /** The text came back unchanged although the case expects redaction, or changed in a `keep` case. */
  readonly changed: boolean;
}

export interface Rate {
  readonly items: number;
  readonly misses: number;
  readonly rate: number;
}
const rate = (items: number, misses: number): Rate => ({
  items,
  misses,
  rate: items === 0 ? 1 : (items - misses) / items,
});

export interface CategoryRow {
  readonly category: RedactionCategory;
  readonly cases: number;
  /** Recall over every `redact` string of the category, known gaps included. */
  readonly recall: Rate;
  /** Recall over the cases that are not a documented gap: this one gates. */
  readonly gatedRecall: Rate;
  readonly falsePositives: Rate;
}

export interface RedactionReport {
  readonly label: string;
  readonly cases: number;
  readonly byCategory: readonly CategoryRow[];
  readonly overall: {
    readonly recall: Rate;
    readonly gatedRecall: Rate;
    readonly falsePositives: Rate;
    /** False positives outside the cases marked as a known gap: this one gates. */
    readonly gatedFalsePositives: Rate;
    /** `keep` cases whose text came back different at all (over-redaction of harmless text). */
    readonly keepCasesAltered: Rate;
  };
  readonly failures: readonly {
    readonly id: string;
    readonly category: RedactionCategory;
    readonly known: boolean;
    readonly leaked: readonly string[];
    readonly destroyed: readonly string[];
  }[];
  /** Ids of the `keep` cases whose text changed at all (over-redaction of harmless text). */
  readonly alteredKeepCases: readonly string[];
}

export function evaluateRedaction(
  label: string,
  cases: readonly RedactionCase[],
  redact: RedactFn,
): RedactionReport {
  const outcomes: CaseOutcome[] = cases.map((item) => {
    const output = redact(item.text, item.names ?? []);
    const leaked = item.redact.filter((value) => leaks(item.category, value, output));
    const destroyed = item.keep.filter((value) => !output.includes(value));
    return {
      id: item.id,
      category: item.category,
      known: item.known,
      leaked,
      destroyed,
      redactItems: item.redact.length,
      keepItems: item.keep.length,
      changed: output !== item.text,
    };
  });

  const sum = (rows: readonly CaseOutcome[], pick: (row: CaseOutcome) => number): number =>
    rows.reduce((total, row) => total + pick(row), 0);
  const recallOf = (rows: readonly CaseOutcome[]): Rate =>
    rate(
      sum(rows, (row) => row.redactItems),
      sum(rows, (row) => row.leaked.length),
    );
  const fpOf = (rows: readonly CaseOutcome[]): Rate =>
    rate(
      sum(rows, (row) => row.keepItems),
      sum(rows, (row) => row.destroyed.length),
    );

  const byCategory = REDACTION_CATEGORIES.map((category): CategoryRow => {
    const rows = outcomes.filter((row) => row.category === category);
    return {
      category,
      cases: rows.length,
      recall: recallOf(rows),
      gatedRecall: recallOf(rows.filter((row) => !row.known)),
      falsePositives: fpOf(rows),
    };
  }).filter((row) => row.cases > 0);

  const keepCases = outcomes.filter((row) => row.category === 'keep');
  return {
    label,
    cases: outcomes.length,
    byCategory,
    overall: {
      recall: recallOf(outcomes),
      gatedRecall: recallOf(outcomes.filter((row) => !row.known)),
      falsePositives: fpOf(outcomes),
      gatedFalsePositives: fpOf(outcomes.filter((row) => !row.known)),
      keepCasesAltered: rate(keepCases.length, keepCases.filter((row) => row.changed).length),
    },
    alteredKeepCases: keepCases.filter((row) => row.changed).map((row) => row.id),
    failures: outcomes
      .filter((row) => row.leaked.length > 0 || row.destroyed.length > 0)
      .map((row) => ({
        id: row.id,
        category: row.category,
        known: row.known,
        leaked: row.leaked,
        destroyed: row.destroyed,
      })),
  };
}

const pct = (value: Rate): string =>
  `${(value.rate * 100).toFixed(1)}% (${String(value.items - value.misses)}/${String(value.items)})`;

export function formatRedactionReport(report: RedactionReport): string {
  const lines = [
    `Redaction eval: ${report.label} (${String(report.cases)} cases, deterministic, no model)`,
    '',
    'category          cases  recall              recall w/o known gaps  false positives',
  ];
  for (const row of report.byCategory) {
    lines.push(
      `${row.category.padEnd(17)} ${String(row.cases).padStart(5)}  ${pct(row.recall).padEnd(19)} ${pct(row.gatedRecall).padEnd(22)} ${pct(row.falsePositives)}`,
    );
  }
  const all = report.overall;
  lines.push(
    '',
    `overall recall: ${pct(all.recall)} · without documented gaps: ${pct(all.gatedRecall)}`,
    `false positives (strings that had to stay): ${String(all.falsePositives.misses)} of ${String(all.falsePositives.items)} destroyed`,
    `keep cases altered at all: ${String(all.keepCasesAltered.misses)} of ${String(all.keepCasesAltered.items)}${report.alteredKeepCases.length > 0 ? ` (${report.alteredKeepCases.join(', ')})` : ''}`,
  );
  if (report.failures.length > 0) {
    lines.push('', 'misses (known = documented gap, does not gate):');
    for (const failure of report.failures) {
      const parts = [
        failure.leaked.length > 0 ? `leaked ${String(failure.leaked.length)}` : '',
        failure.destroyed.length > 0 ? `destroyed ${failure.destroyed.join(' | ')}` : '',
      ].filter((part) => part !== '');
      lines.push(`  ${failure.id}${failure.known ? ' [known]' : ''}: ${parts.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Gate: every `redact` string outside a documented gap must be gone, and at most `maxFalsePositive`
 * of the `keep` strings outside a documented gap may be destroyed (a share between 0 and 1).
 */
export function redactionGate(
  report: RedactionReport,
  options: { readonly minRecall: number; readonly maxFalsePositive: number },
): string[] {
  const problems: string[] = [];
  if (report.overall.gatedRecall.rate < options.minRecall) {
    problems.push(
      `recall ${pct(report.overall.gatedRecall)} is under ${String(options.minRecall)}`,
    );
  }
  const fp = 1 - report.overall.gatedFalsePositives.rate;
  if (fp > options.maxFalsePositive) {
    problems.push(
      `false positives ${(fp * 100).toFixed(1)}% are over ${String(options.maxFalsePositive * 100)}%`,
    );
  }
  return problems;
}
