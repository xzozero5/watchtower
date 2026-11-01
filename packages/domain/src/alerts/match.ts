import {
  serviceMatchRuleSchema,
  type AlertSource,
  type ServiceMatchRule,
} from '@watchtower/shared';

/** A service as far as matching is concerned. `matchRules` is the raw jsonb: a bad rule is skipped. */
export interface CatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly matchRules: unknown;
}

export interface AlertFacts {
  readonly source: AlertSource;
  readonly title: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** How many conditions a rule names: the more it names, the more specific it is. */
export function ruleSpecificity(rule: ServiceMatchRule): number {
  return (
    (rule.source === undefined ? 0 : 1) +
    (rule.policyName === undefined ? 0 : 1) +
    Object.keys(rule.labels).length
  );
}

/** True when every condition the rule names holds for the alert. */
export function ruleMatches(rule: ServiceMatchRule, alert: AlertFacts): boolean {
  if (rule.source !== undefined && rule.source !== alert.source) return false;
  if (
    rule.policyName !== undefined &&
    rule.policyName.trim().toLowerCase() !== alert.title.trim().toLowerCase()
  ) {
    return false;
  }
  return Object.entries(rule.labels).every(([key, value]) => alert.labels[key] === value);
}

function rulesOf(entry: CatalogEntry): ServiceMatchRule[] {
  if (!Array.isArray(entry.matchRules)) return [];
  const rules: ServiceMatchRule[] = [];
  for (const raw of entry.matchRules as readonly unknown[]) {
    const parsed = serviceMatchRuleSchema.safeParse(raw);
    if (parsed.success) rules.push(parsed.data);
  }
  return rules;
}

/**
 * The service an alert belongs to, or null (the "unmapped" bucket, R-3.7). Between several matching
 * services the one with the most specific matching rule wins; a tie goes to the smaller slug, so the
 * answer never depends on row order.
 */
export function matchService(catalog: readonly CatalogEntry[], alert: AlertFacts): string | null {
  let best: { id: string; slug: string; score: number } | null = null;
  for (const entry of catalog) {
    for (const rule of rulesOf(entry)) {
      if (!ruleMatches(rule, alert)) continue;
      const score = ruleSpecificity(rule);
      if (best === null || score > best.score || (score === best.score && entry.slug < best.slug)) {
        best = { id: entry.id, slug: entry.slug, score };
      }
    }
  }
  return best?.id ?? null;
}
