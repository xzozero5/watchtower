import { createHash } from 'node:crypto';

/** The dimension set of a point: declared names to short strings (the organization id included). */
export type DimSet = Readonly<Record<string, string>>;

/** Sorted `[name, value]` pairs as JSON: the same set always gives the same text, whatever order it arrived in. */
export function canonicalDims(dims: DimSet): string {
  return JSON.stringify(Object.entries(dims).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** SHA-256 of the canonical set: the key of a series. */
export function dimsHash(dims: DimSet): string {
  return createHash('sha256').update(canonicalDims(dims)).digest('hex');
}

/** SHA-256 of a template, for the audit row: it says that a template changed without copying SQL into the log. */
export function templateHash(template: string): string {
  return createHash('sha256').update(template).digest('hex');
}
