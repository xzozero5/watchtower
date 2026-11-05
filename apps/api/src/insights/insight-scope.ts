import {
  isInsightPeriodAllowed,
  type InsightElement,
  type InsightPeriodSpec,
  type InsightScope,
} from '@watchtower/shared';

/**
 * Scope and period of an insight request (ADR-029 section 9.3). The client names one `scope` and one `period` for the
 * whole call, or neither; an element that cannot use them is left out, like an element the person may not read.
 */

/** The scope kinds that name a row somebody may or may not be allowed to open. */
export const ROW_SCOPES = ['org', 'intent', 'incident', 'service'] as const;
export type RowScope = (typeof ROW_SCOPES)[number];

export type ParsedScopeKey =
  { readonly kind: 'instance' | 'user' } | { readonly kind: RowScope; readonly id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isRowScope(kind: string): kind is RowScope {
  return (ROW_SCOPES as readonly string[]).includes(kind);
}

/** `instance`, `user`, or `org|intent|incident|service:<uuid>`; anything else is not a scope key. */
export function parseScopeKey(key: string): ParsedScopeKey | null {
  if (key === 'instance' || key === 'user') return { kind: key };
  const [kind, id, ...rest] = key.split(':');
  if (kind === undefined || id === undefined || rest.length > 0) return null;
  return isRowScope(kind) && UUID.test(id) ? { kind, id } : null;
}

/**
 * The scope key an element is read under. Left out by the client: an `instance` or `user` element uses its own, a
 * row scope needs to be named. Named: it must be of the kind the element has.
 */
export function scopeKeyFor(element: InsightElement, requested: string | undefined): string | null {
  const wanted: InsightScope = element.scope;
  if (requested === undefined) return wanted === 'instance' || wanted === 'user' ? wanted : null;
  const parsed = parseScopeKey(requested);
  return parsed !== null && parsed.kind === wanted ? requested : null;
}

function defaultFor(spec: InsightPeriodSpec): string | null {
  switch (spec.kind) {
    case 'none':
      return '-';
    case 'now':
      return 'now';
    case 'days':
      return `d${String(Math.min(spec.max, Math.max(spec.min, 7)))}`;
    case 'shift':
    case 'isoWeek':
      return null;
  }
}

/** The period an element is read for: the one asked, if its spec allows it, else its default; null = leave it out. */
export function periodFor(
  element: InsightElement,
  requested: string | undefined,
  now: Date = new Date(),
): string | null {
  if (requested !== undefined) {
    return isInsightPeriodAllowed(element.periods, requested, now) ? requested : null;
  }
  for (const spec of element.periods) {
    const period = defaultFor(spec);
    if (period !== null) return period;
  }
  return null;
}

/** Days of a `d{n}` period (the builders take a number). */
export function daysOf(period: string): number {
  const match = /^d(\d{1,3})$/.exec(period);
  return match?.[1] === undefined ? 7 : Number(match[1]);
}
