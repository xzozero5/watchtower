import { z } from 'zod';

/** Building blocks shared by the HTTP contracts of the ticketing endpoints. */

export const idParamSchema = z.object({ id: z.uuid() });

export const jsonRecordSchema = z.record(z.string(), z.unknown());

/** Opaque value from the previous page's `nextCursor`. */
export const cursorSchema = z.string().min(1).max(300);

export function pageLimit(fallback = 50, max = 200) {
  return z.coerce.number().int().min(1).max(max).default(fallback);
}

/**
 * A list filter that accepts `a,b` or a repeated `a=1&a=2` query parameter and yields an array.
 * An empty value means "no filter".
 */
export function csvList<Schema extends z.ZodType>(item: Schema) {
  return z.preprocess((value: unknown): unknown => {
    if (value === undefined || value === '') return undefined;
    const parts: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
    const items: unknown[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        for (const piece of part.split(',')) {
          const trimmed = piece.trim();
          if (trimmed !== '') items.push(trimmed);
        }
      } else {
        items.push(part);
      }
    }
    return items;
  }, z.array(item).min(1).max(20).optional());
}

export function pageOf<Schema extends z.ZodType>(item: Schema) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
