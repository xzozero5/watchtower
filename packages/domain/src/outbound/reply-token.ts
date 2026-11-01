import { schema } from '@watchtower/db';
import {
  SecretBoxError,
  openSecret,
  replyTokenAad,
  sealSecret,
} from '@watchtower/shared/secret-box';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';

import type { DbTransaction, DomainContext } from '../types.js';

/**
 * The LINE reply token, kept sealed in `inbound_message.reply_token_sealed` (ADR-010 section 6). A
 * token is free but works once and for about a minute, so the dispatcher takes it with a conditional
 * UPDATE that clears it in the same statement: two dispatchers cannot both use it.
 */

export function sealReplyToken(
  ctx: Pick<DomainContext, 'config'>,
  inboundMessageId: string,
  token: string,
): string {
  return sealSecret(ctx.config.sealKey, token, replyTokenAad(inboundMessageId));
}

export interface StoredToken {
  readonly inboundMessageId: string;
  /** When the webhook that carried the token happened (the router measures its lifetime from here). */
  readonly receivedAt: Date;
}

/** The newest inbound message of the ticket that still holds a token, locked. Null when none. */
export async function findReplyToken(
  tx: DbTransaction,
  ticketId: string,
): Promise<StoredToken | null> {
  const [row] = await tx
    .select({ id: schema.inboundMessage.id, receivedAt: schema.inboundMessage.receivedAt })
    .from(schema.inboundMessage)
    .where(
      and(
        eq(schema.inboundMessage.ticketId, ticketId),
        isNotNull(schema.inboundMessage.replyTokenSealed),
      ),
    )
    .orderBy(desc(schema.inboundMessage.receivedAt))
    .limit(1)
    .for('update');
  return row === undefined ? null : { inboundMessageId: row.id, receivedAt: row.receivedAt };
}

/**
 * Spends the token: clears it and returns the plain value, or null when someone else already did
 * (or it cannot be opened). The token is gone whatever the outcome of the call that uses it.
 */
export async function spendReplyToken(
  tx: DbTransaction,
  ctx: Pick<DomainContext, 'config'>,
  inboundMessageId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ sealed: schema.inboundMessage.replyTokenSealed })
    .from(schema.inboundMessage)
    .where(eq(schema.inboundMessage.id, inboundMessageId))
    .for('update');
  const sealed = row?.sealed ?? null;
  if (sealed === null) return null;
  const cleared = await tx
    .update(schema.inboundMessage)
    .set({ replyTokenSealed: null })
    .where(
      and(
        eq(schema.inboundMessage.id, inboundMessageId),
        isNotNull(schema.inboundMessage.replyTokenSealed),
      ),
    )
    .returning({ id: schema.inboundMessage.id });
  if (cleared.length === 0) return null;
  try {
    return openSecret(ctx.config.sealKey, sealed, replyTokenAad(inboundMessageId));
  } catch (error) {
    if (error instanceof SecretBoxError) return null;
    throw error;
  }
}

/** Blanks tokens nobody can use any more (LINE accepts them for about a minute). Returns how many. */
export async function clearStaleReplyTokens(
  tx: Pick<DbTransaction, 'update'>,
  olderThan: Date,
): Promise<number> {
  const rows = await tx
    .update(schema.inboundMessage)
    .set({ replyTokenSealed: null })
    .where(
      and(
        isNotNull(schema.inboundMessage.replyTokenSealed),
        lt(schema.inboundMessage.receivedAt, olderThan),
      ),
    )
    .returning({ id: schema.inboundMessage.id });
  return rows.length;
}
