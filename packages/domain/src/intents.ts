import { schema } from '@watchtower/db';
import { eq } from 'drizzle-orm';

import { badRequest } from './errors.js';
import type { IntentRow } from './rows.js';
import type { ReadExecutor } from './types.js';

/**
 * The intent a ticket is filed under, by id or by key. Null when the caller named none: the ticket
 * is then unclassified and a person (or the AI) triages it. An unknown or inactive intent is the
 * caller's mistake.
 */
export async function resolveIntent(
  executor: ReadExecutor,
  ref: { readonly intentId?: string | undefined; readonly intentKey?: string | undefined },
): Promise<IntentRow | null> {
  if (ref.intentId === undefined && ref.intentKey === undefined) return null;
  const [row] = await executor
    .select()
    .from(schema.intent)
    .where(
      ref.intentId === undefined
        ? eq(schema.intent.key, ref.intentKey ?? '')
        : eq(schema.intent.id, ref.intentId),
    )
    .limit(1);
  if (!row?.isActive) throw badRequest('Unknown or inactive intent');
  if (ref.intentId !== undefined && ref.intentKey !== undefined && row.key !== ref.intentKey) {
    throw badRequest('intentId and intentKey name different intents');
  }
  return row;
}
