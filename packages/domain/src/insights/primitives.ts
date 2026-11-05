import { createHash } from 'node:crypto';

import {
  DEFAULT_INSIGHT_MATERIALITY,
  type InsightFact,
  type InsightMateriality,
  type InsightRefKind,
} from '@watchtower/shared';

/**
 * The deterministic part of an embedded insight (ADR-029 section 9.2): comparison against the 7-day
 * baseline, share, top drivers, and the bucketing that decides whether a narration is worth regenerating
 * (section 9.4). Pure functions: no database, no clock, no model.
 */

// --- delta ------------------------------------------------------------------------------------------------

export type DeltaDirection = 'up' | 'down' | 'flat';

export interface Delta {
  readonly current: number;
  readonly baseline: number;
  /** Whole percent against the baseline; null when the baseline is 0 (nothing to compare to). */
  readonly percent: number | null;
  readonly direction: DeltaDirection;
}

/** A change smaller than this many percent reads as "in line with the average". */
export const DELTA_FLAT_PERCENT = 5;

/**
 * `current` against `baseline7d` (the average of the 7 days before). `percent` is `null` when the baseline is
 * 0: the claim is then "new", never an infinite percentage (N5).
 */
export function delta(current: number, baseline7d: number): Delta {
  if (!Number.isFinite(current) || !Number.isFinite(baseline7d) || baseline7d < 0) {
    throw new RangeError('delta needs finite numbers and a non-negative baseline');
  }
  if (baseline7d === 0) {
    return {
      current,
      baseline: baseline7d,
      percent: null,
      direction: current === 0 ? 'flat' : 'up',
    };
  }
  const percent = Math.round(((current - baseline7d) / baseline7d) * 100);
  const direction: DeltaDirection =
    Math.abs(percent) < DELTA_FLAT_PERCENT ? 'flat' : percent > 0 ? 'up' : 'down';
  return { current, baseline: baseline7d, percent, direction };
}

// --- share ------------------------------------------------------------------------------------------------

/** `part` of `whole` as a whole percent, 0 to 100; null when there is no whole. */
export function share(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || part < 0 || whole < 0) {
    throw new RangeError('share needs non-negative finite numbers');
  }
  if (whole === 0) return null;
  return Math.min(100, Math.round((part / whole) * 100));
}

// --- top drivers ------------------------------------------------------------------------------------------

/**
 * What a driver may be grouped by: entities a staff member created in a catalog (C-14). A value that came
 * from a webhook or a customer (an alert title, a subject, a channel string) can steer a model, so it is not
 * a grouping key.
 */
export const DRIVER_GROUP_BY = ['intent', 'service', 'queue', 'org'] as const;
export type DriverGroupBy = (typeof DRIVER_GROUP_BY)[number];

export function isDriverGroupBy(value: string): value is DriverGroupBy {
  return (DRIVER_GROUP_BY as readonly string[]).includes(value);
}

/** The most drivers one claim names (section 9.2). */
export const MAX_DRIVERS = 3;

export interface DriverCandidate {
  /** Id of the catalog entity. */
  readonly id: string;
  /** The name a staff member set. */
  readonly name: string;
  readonly count: number;
}

export interface Driver extends DriverCandidate {
  readonly groupBy: DriverGroupBy;
  /** Share of the total, whole percent; null when the total is 0. */
  readonly sharePercent: number | null;
}

/**
 * The largest contributors, at most `n` (never more than 3), biggest first, ties by id so the set is stable
 * between runs. `groupBy` outside the staff catalog throws: a typed caller cannot ask for it, and an untyped
 * one fails loudly instead of leaking an attacker-controlled label to a model.
 */
export function topDrivers(
  groupBy: DriverGroupBy,
  candidates: readonly DriverCandidate[],
  n: number = MAX_DRIVERS,
): Driver[] {
  if (!isDriverGroupBy(groupBy)) {
    throw new RangeError(
      `topDrivers cannot group by ${String(groupBy)}: not a staff catalog entity`,
    );
  }
  const limit = Math.min(MAX_DRIVERS, Math.max(0, Math.floor(n)));
  const positive = candidates.filter((candidate) => candidate.count > 0);
  const total = positive.reduce((sum, candidate) => sum + candidate.count, 0);
  return [...positive]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((candidate) => ({ ...candidate, groupBy, sharePercent: share(candidate.count, total) }));
}

// --- bucket and fingerprint -------------------------------------------------------------------------------

/**
 * Whether `next` is a change worth a new narration against `previous`: a count must move by at least
 * `minChangePercent` of the old value AND by at least `minChangeAbsolute` units (section 9.4).
 */
export function isMaterialCountChange(
  previous: number,
  next: number,
  materiality: InsightMateriality = DEFAULT_INSIGHT_MATERIALITY,
): boolean {
  const change = Math.abs(next - previous);
  if (change < materiality.minChangeAbsolute) return false;
  if (previous === 0) return true;
  return (change / Math.abs(previous)) * 100 >= materiality.minChangePercent;
}

/**
 * A count as the fingerprint sees it: rounded down to a step that is the larger of the absolute floor and the
 * relative threshold, so a wobble smaller than "10% and 3 units" stays in the same bucket.
 * `[ASSUMED]` an approximation of the pairwise rule above that needs no previous value.
 */
export function bucketCount(
  value: number,
  materiality: InsightMateriality = DEFAULT_INSIGHT_MATERIALITY,
): number {
  const magnitude = Math.abs(value);
  const unit = Math.max(1, materiality.minChangeAbsolute);
  // Small counts move in steps of the absolute floor; from the point where 10% is more than that floor, in
  // geometric steps of 10%, so 100 and 104 share a bucket and 111 does not.
  const crossover = Math.ceil((unit * 100) / Math.max(1, materiality.minChangePercent));
  if (magnitude < crossover) return Math.sign(value) * Math.floor(magnitude / unit) * unit;
  const ratio = 1 + materiality.minChangePercent / 100;
  return Math.sign(value) * Math.round(ratio ** Math.floor(Math.log(magnitude) / Math.log(ratio)));
}

/** A percentage in steps of `percentStepPp` points. */
export function bucketPercent(
  value: number,
  materiality: InsightMateriality = DEFAULT_INSIGHT_MATERIALITY,
): number {
  return Math.round(value / materiality.percentStepPp) * materiality.percentStepPp;
}

/** Fact ids that end in `_pct` are percentages (a share, a rate, a delta); the rest of the numbers are counts. */
const isPercentFact = (fact: InsightFact): boolean =>
  fact.kind === 'delta' || fact.id.endsWith('_pct');

/**
 * The value of one fact after bucketing. A `driver` fact stands for its entity, not its count: the set of
 * top drivers is what matters (a count that shifts inside the set is not news).
 */
export function bucketFact(
  fact: InsightFact,
  materiality: InsightMateriality = DEFAULT_INSIGHT_MATERIALITY,
): string {
  if (fact.kind === 'driver') {
    return fact.ref === undefined ? fact.id : `${fact.ref.kind}:${fact.ref.id}`;
  }
  if (typeof fact.value === 'string') return fact.value;
  return String(
    isPercentFact(fact)
      ? bucketPercent(fact.value, materiality)
      : bucketCount(fact.value, materiality),
  );
}

/**
 * The hash that says "nothing worth a new narration changed": over the bucketed facts, ordered by id, with
 * the driver set sorted. Same fingerprint = renew the old narration without calling a model (section 9.4).
 * Display strings and refs of non-driver facts are not in it: they follow the values.
 */
export function factsFingerprint(
  facts: readonly InsightFact[],
  materiality: InsightMateriality = DEFAULT_INSIGHT_MATERIALITY,
): string {
  const scalar = facts
    .filter((fact) => fact.kind !== 'driver')
    .map((fact) => `${fact.id}=${bucketFact(fact, materiality)}`)
    .sort();
  const drivers = facts
    .filter((fact) => fact.kind === 'driver')
    .map((fact) => bucketFact(fact, materiality))
    .sort();
  return createHash('sha256')
    .update(JSON.stringify({ scalar, drivers }))
    .digest('hex')
    .slice(0, 32);
}

/** Drops facts that carry a ref kind a `masked` view must not see (a customer: `org`, `contact`). */
export function dropMaskedRefs(
  facts: readonly InsightFact[],
  maskedKinds: readonly InsightRefKind[],
): InsightFact[] {
  return facts.filter((fact) => fact.ref === undefined || !maskedKinds.includes(fact.ref.kind));
}
