import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  OTHER_MAIL_DISPOSITIONS,
  type ChannelType,
  type OtherMailDisposition,
  type TicketPriority,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { createTicket } from '../tickets/create.js';
import { ticketKeysOf } from '../tickets/support.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { ensureSenderContact, lookupSender } from './identity.js';
import { ticketSubject } from './ingest.js';
import type { InboundAttachment, NormalisedInboundMessage } from './types.js';

export interface ConvertInboundInput {
  readonly inboundMessageId: string;
  readonly priority?: TicketPriority | undefined;
  readonly intentKey?: string | undefined;
}

export interface ConvertInboundOutcome {
  readonly inboundMessageId: string;
  readonly ticketId: string;
  readonly ticketKey: string;
  readonly convertedFrom: OtherMailDisposition;
  /** True when the message had been converted before and nothing was written now. */
  readonly alreadyConverted: boolean;
}

const isOtherMail = (value: string): value is OtherMailDisposition =>
  (OTHER_MAIL_DISPOSITIONS as readonly string[]).includes(value);

/**
 * "This is a ticket" (UI spec section 7, PRD R-2.7): a person takes a message the system left in Other mail
 * (noise, an automatic reply, internal mail) and opens a ticket from it, the same way ingestion would
 * have for a person's mail. The ticket is attributed to the sender's contact and organization (an
 * unknown sender is an unverified contact of the placeholder organization). Nothing is sent to
 * anybody: not an acknowledgment, not a reply.
 *
 * The row is locked, so two people pressing the button at once make one ticket; asking again for a
 * message already converted returns that ticket and writes nothing. A message that is not in Other
 * mail (it is a ticket already, or was never decided) is refused with 409.
 */
export async function convertInboundMessage(
  tx: DbTransaction,
  ctx: DomainContext,
  input: ConvertInboundInput,
): Promise<DomainResult<ConvertInboundOutcome>> {
  const fx = new Effects();
  const [row] = await tx
    .select()
    .from(schema.inboundMessage)
    .where(eq(schema.inboundMessage.id, input.inboundMessageId))
    .for('update');
  if (!row) throw notFound('No such message');
  const keys = ticketKeysOf(ctx);

  if (row.convertedFrom !== null && row.ticketId !== null) {
    const [ticket] = await tx
      .select({ number: schema.ticket.number })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, row.ticketId))
      .limit(1);
    if (!ticket || !isOtherMail(row.convertedFrom))
      throw conflict('This message is a ticket already');
    return fx.result({
      inboundMessageId: row.id,
      ticketId: row.ticketId,
      ticketKey: keys.format(ticket.number),
      convertedFrom: row.convertedFrom,
      alreadyConverted: true,
    });
  }
  if (!isOtherMail(row.disposition)) {
    throw conflict('Only mail that did not become a ticket can be turned into one');
  }
  const convertedFrom = row.disposition;

  const [account] = await tx
    .select({ type: schema.channelAccount.type })
    .from(schema.channelAccount)
    .where(eq(schema.channelAccount.id, row.channelAccountId))
    .limit(1);
  if (!account) throw badRequest('The message has no channel account');
  const channel = account.type as ChannelType;

  const from: NormalisedInboundMessage['from'] = {
    address: row.fromAddress,
    name: row.fromName,
    lineUserId: row.lineUserId,
  };
  const sender = await lookupSender(tx, from);
  const { contact } = await ensureSenderContact(tx, ctx, fx, from, sender);
  const created = await createTicket(tx, ctx, {
    orgId: contact.orgId,
    subject: ticketSubject({ subject: row.subject, bodyText: row.bodyText }),
    body: row.bodyText,
    ...(row.bodyHtml === null ? {} : { bodyHtml: row.bodyHtml }),
    ...(row.emailMeta == null ? {} : { emailMeta: row.emailMeta as Record<string, unknown> }),
    attachments: (row.attachments as readonly InboundAttachment[]).map((attachment) => ({
      ...attachment,
    })),
    channel,
    channelAccountId: row.channelAccountId,
    externalId: row.providerMessageId,
    ...(row.threadKey === null ? {} : { threadKey: row.threadKey }),
    requesterContactId: contact.id,
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.intentKey === undefined ? {} : { intentKey: input.intentKey }),
  });
  fx.events.push(...created.events);
  if (created.audited) fx.audited = true;
  const { ticket, message } = created.value;

  await tx
    .update(schema.inboundMessage)
    .set({
      disposition: 'ticket',
      ticketId: ticket.id,
      messageId: message.id,
      convertedFrom,
      dispositionBy: `user:${ctx.actor.id ?? 'unknown'}`,
      dispositionAt: ctx.now(),
    })
    .where(eq(schema.inboundMessage.id, row.id));

  // Ids and labels only: the sender's address and the text stay in inbound_message / message.
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.inboundConvert,
    targetType: 'inbound_message',
    targetId: row.id,
    metadata: {
      convertedFrom,
      ticketId: ticket.id,
      channelAccountId: row.channelAccountId,
      senderKnown: sender.contact !== null,
    },
  });
  return fx.result({
    inboundMessageId: row.id,
    ticketId: ticket.id,
    ticketKey: keys.format(ticket.number),
    convertedFrom,
    alreadyConverted: false,
  });
}
