import { schema } from '@watchtower/db';
import {
  INSIGHT_MASKED_REF_KINDS,
  insightFactsResultSchema,
  type InsightFact,
  type InsightFactsResult,
  type InsightRef,
} from '@watchtower/shared';
import { inArray } from 'drizzle-orm';

import type { SqlExecutor } from '../types.js';
import { dropMaskedRefs, type Delta, type Driver } from './primitives.js';

/**
 * Where a facts builder reads from. The database handle, a transaction, or a read-only pool's handle (the
 * assistant's pool, T-401): a builder never takes a principal, so the caller settles who may see the element
 * before it calls (ADR-029 section 9.3).
 */
export type InsightExecutor = SqlExecutor;

/** `masked`: the view of the `dev` role, which must not carry a customer (`org`, `contact` refs). */
export type InsightView = 'full' | 'masked';

export interface InsightBuildOptions {
  readonly executor: InsightExecutor;
  readonly view?: InsightView;
  /** The clock; tests pass a fixed one. Database-side windows use the database clock. */
  readonly now?: Date;
}

export interface Localized {
  readonly th: string;
  readonly en: string;
}

/** Names a staff member set are cut so one very long name cannot crowd out the facts. */
const NAME_MAX = 60;
export const clip = (name: string): string =>
  name.length <= NAME_MAX ? name : `${name.slice(0, NAME_MAX - 1)}…`;

export function metric(
  id: string,
  value: number,
  display: Localized,
  ref?: InsightRef,
): InsightFact {
  return { id, kind: 'metric', value, display, ...(ref === undefined ? {} : { ref }) };
}

export function state(
  id: string,
  value: string,
  display: Localized,
  ref?: InsightRef,
): InsightFact {
  return { id, kind: 'state', value, display, ...(ref === undefined ? {} : { ref }) };
}

/** The delta against the 7-day average as a fact; none when the baseline was 0 (there is nothing to compare). */
export function deltaFact(id: string, subject: Localized, change: Delta): InsightFact[] {
  if (change.percent === null) return [];
  const percent = Math.abs(change.percent);
  const th =
    change.direction === 'flat'
      ? `${subject.th} ใกล้เคียงค่าเฉลี่ย 7 วัน`
      : change.direction === 'up'
        ? `${subject.th} เพิ่มขึ้น ${String(percent)}% จากค่าเฉลี่ย 7 วัน`
        : `${subject.th} ลดลง ${String(percent)}% จากค่าเฉลี่ย 7 วัน`;
  const en =
    change.direction === 'flat'
      ? `${subject.en} is in line with the 7-day average`
      : change.direction === 'up'
        ? `${subject.en} is up ${String(percent)}% on the 7-day average`
        : `${subject.en} is down ${String(percent)}% on the 7-day average`;
  return [{ id, kind: 'delta', value: change.percent, display: { th, en } }];
}

/** Top drivers as `driver` facts `<prefix>_1..3`; the ref names the catalog entity, the value is its count. */
export function driverFacts(
  prefix: string,
  subject: Localized,
  drivers: readonly Driver[],
): InsightFact[] {
  return drivers.map((driver, index) => ({
    id: `${prefix}_${String(index + 1)}`,
    kind: 'driver' as const,
    value: driver.count,
    display: {
      th: `${subject.th}: ${clip(driver.name)} (${String(driver.count)})`,
      en: `${subject.en}: ${clip(driver.name)} (${String(driver.count)})`,
    },
    ref: { kind: driver.groupBy, id: driver.id },
  }));
}

/** Names of staff-catalog rows by id. A missing row is simply absent. */
export async function queueNames(
  executor: InsightExecutor,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: schema.teamQueue.id, name: schema.teamQueue.name })
    .from(schema.teamQueue)
    .where(inArray(schema.teamQueue.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function serviceNames(
  executor: InsightExecutor,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: schema.service.id, name: schema.service.name })
    .from(schema.service)
    .where(inArray(schema.service.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Applies the view and checks the result against the contract (at most 60 facts, ids unique, no free text field). */
export function finishFacts(
  facts: readonly InsightFact[],
  asOf: Date,
  view: InsightView = 'full',
): InsightFactsResult {
  const visible = view === 'masked' ? dropMaskedRefs(facts, INSIGHT_MASKED_REF_KINDS) : [...facts];
  const ids = new Set<string>();
  for (const fact of visible) {
    if (ids.has(fact.id)) throw new Error(`duplicate insight fact id ${fact.id}`);
    ids.add(fact.id);
  }
  return insightFactsResultSchema.parse({ facts: visible, asOf: asOf.toISOString() });
}
