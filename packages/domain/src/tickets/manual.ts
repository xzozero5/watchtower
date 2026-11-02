import { schema } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  type ConfirmationStatus,
  type CreateManualTicket,
} from '@watchtower/shared';
import { and, arrayContains, asc, eq, isNull } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { isDomainError } from '../errors.js';
import { scheduleTemplateAck } from '../outbound/schedule.js';
import type { ContactRow, MessageRow, TicketRow } from '../rows.js';
import { Effects, type DbTransaction, type DomainContext, type DomainResult } from '../types.js';
import { createTicket } from './create.js';

/** The acknowledgment a ticket filed by hand sends: a template on the safe list, fixed words (N3). */
export const MANUAL_CONFIRMATION_TEMPLATE = 'auto_ack.received_with_sla';

export interface CreateManualTicketResult {
  readonly ticket: TicketRow;
  readonly message: MessageRow;
  readonly contact: ContactRow;
  /** False when the contact was already known. */
  readonly contactCreated: boolean;
  readonly confirmation: ConfirmationStatus;
}

/**
 * A ticket a person files for something that happened outside Watchtower: a phone call, a visit, a chat
 * that is not connected (T-136). One transaction: the contact (found, or created unverified, po #26), the
 * ticket with the SLA clock starting now (`createdAt` is the time of filing, never an earlier one), the
 * first message, and the confirmation email.
 *
 * The confirmation is an automatic acknowledgment from a safe template, sent through the policy gate as
 * the system (N3), by the Gmail account. It goes by default to a contact that already existed; an address
 * that is new here needs `sendConfirmation: true`, so a typo does not send mail to a stranger `[ASSUMED]`.
 * It is never an error: no address or no Gmail account just means it was not sent.
 */
export async function createManualTicket(
  tx: DbTransaction,
  ctx: DomainContext,
  input: CreateManualTicket,
): Promise<DomainResult<CreateManualTicketResult>> {
  const fx = new Effects();

  let known = input.requesterContactId !== undefined;
  if (input.requester !== undefined) {
    const [existing] = await tx
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .where(arrayContains(schema.contact.emails, [input.requester.email.trim().toLowerCase()]))
      .limit(1);
    known = existing !== undefined;
  }

  const created = await createTicket(tx, ctx, {
    orgId: input.orgId,
    subject: input.subject,
    body: input.body,
    channel: input.channel,
    ...(input.requesterContactId === undefined
      ? {}
      : { requesterContactId: input.requesterContactId }),
    ...(input.requester === undefined ? {} : { requester: input.requester }),
    ...(input.intentId === undefined ? {} : { intentId: input.intentId }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.queueId === undefined ? {} : { queueId: input.queueId }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
  });
  fx.events.push(...created.events);
  if (created.audited) fx.audited = true;
  const { ticket, message } = created.value;

  const contactId = ticket.requesterContactId;
  if (contactId === null) throw new Error('a ticket filed by hand has a contact');
  const [contact] = await tx
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  if (!contact) throw new Error('the contact of the new ticket vanished');

  let confirmation: ConfirmationStatus = 'not_requested';
  const wanted = input.sendConfirmation ?? known;
  if (wanted) {
    const address = contact.emails[0];
    if (address === undefined) {
      confirmation = 'no_address';
    } else {
      const [account] = await tx
        .select({ id: schema.channelAccount.id })
        .from(schema.channelAccount)
        .where(
          and(eq(schema.channelAccount.type, 'gmail'), isNull(schema.channelAccount.disabledAt)),
        )
        .orderBy(asc(schema.channelAccount.createdAt))
        .limit(1);
      if (account === undefined) {
        confirmation = 'no_email_account';
      } else {
        // As the system: the gate judges an automatic message by its origin, and a person's hand is not in it.
        const systemCtx: DomainContext = { ...ctx, actor: { type: 'system', id: null } };
        try {
          // A savepoint: a refusal by the gate must not undo the ticket the person just filed.
          const scheduled = await tx.transaction((savepoint) =>
            scheduleTemplateAck(savepoint, systemCtx, {
              ref: ticket.id,
              templateKey: MANUAL_CONFIRMATION_TEMPLATE,
              via: { accountId: account.id, channel: 'gmail' },
            }),
          );
          fx.events.push(...scheduled.events);
          await recordAuditInTx(tx, ctx, fx, {
            action: AUDIT_ACTIONS.ticketConfirmationQueued,
            targetType: 'ticket',
            targetId: ticket.id,
            // The delivery and the contact by id; the address itself stays out of the audit log.
            metadata: { deliveryId: scheduled.value.delivery.id, contactId },
          });
          confirmation = 'queued';
        } catch (error) {
          if (!isDomainError(error) || error.code !== 'policy_denied') throw error;
          confirmation = 'blocked_by_policy';
        }
      }
    }
  }

  return fx.result({ ticket, message, contact, contactCreated: !known, confirmation });
}
