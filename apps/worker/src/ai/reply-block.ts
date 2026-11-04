import { schema, type Database } from '@watchtower/db';
import { hasOutboundChannel, type AiReplyBlockReason } from '@watchtower/shared';
import { and, eq, isNull } from 'drizzle-orm';

/** Channels that need a connected account to send on. `[ASSUMED]` portal needs none (the reply is read on the portal). */
const ACCOUNT_CHANNELS: readonly string[] = ['gmail', 'line'];

/**
 * Why the AI must not offer a customer reply on a ticket of this channel (T-147, QA-29), or null when
 * a reply could be delivered. The first reason is the channel itself (internal, phone, walk-in, chat,
 * other: nothing is delivered, the same rule the api applies to a send); the second is a channel whose
 * account is missing or switched off. A draft nobody could send only invites a wrong click.
 */
export async function replyBlockReason(
  db: Pick<Database['db'], 'select'>,
  channel: string,
): Promise<AiReplyBlockReason | null> {
  if (!hasOutboundChannel(channel)) return 'no_outbound_channel';
  if (!ACCOUNT_CHANNELS.includes(channel)) return null;
  const [account] = await db
    .select({ id: schema.channelAccount.id })
    .from(schema.channelAccount)
    .where(and(eq(schema.channelAccount.type, channel), isNull(schema.channelAccount.disabledAt)))
    .limit(1);
  return account === undefined ? 'channel_not_connected' : null;
}
