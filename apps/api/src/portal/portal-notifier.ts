import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { schema } from '@watchtower/db';
import {
  DEFAULT_PORTAL_LOCALE,
  PORTAL_EMAIL_TTL_SECONDS,
  PORTAL_TOKEN_FRAGMENT_KEY,
  customerStatus,
  portalCategorySchema,
  portalLocaleSchema,
  portalUrgencySchema,
  portalTrackingPath,
  type CustomerStatus,
  type PortalLocale,
  type TicketStatus,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { EmailOutbox } from '../queue/queue.module.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';
import type { TicketRow } from '../tickets/ticket-reader.js';
import { PortalTokensService } from './portal-tokens.service.js';

type MessageRow = typeof schema.message.$inferSelect;

interface Recipient {
  readonly contactId: string;
  readonly email: string;
  readonly locale: PortalLocale;
}

/** A subject on one line, without control characters, so it is safe in an email header or a log. */
export function oneLine(text: string, max = 300): string {
  // Control characters and line/paragraph separators (\p{Cc}, \p{Zl}, \p{Zp}) become a space.
  return text
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** First word of a display name: customers see "Somchai", never "Somchai Jaidee" (UI spec Q6). */
export function firstName(name: string | null | undefined): string | null {
  const first = oneLine(name ?? '', 100).split(' ')[0];
  return first === undefined || first === '' ? null : first;
}

/**
 * Writes the customer emails of the portal into the transactional outbox (ADR-006), in the same
 * transaction as the change they report: the email exists if and only if the change committed, and
 * a Redis outage delays it without losing it. Only tickets of the `portal` channel get these
 * emails; other channels answer through their own adapter. The worker renders the wording.
 *
 * Each email carries a fresh tracking link, which also starts the link's validity period again.
 */
@Injectable()
export class PortalNotifier {
  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(EmailOutbox) private readonly outbox: EmailOutbox,
    @Inject(PortalTokensService) private readonly tokens: PortalTokensService,
  ) {}

  /** "We received your request", sent once when the portal form creates the ticket. */
  async confirmation(tx: DbTransaction, ticket: TicketRow, ticketKey: string): Promise<void> {
    const to = await this.recipient(tx, ticket);
    if (!to) return;
    await this.outbox.send(
      {
        kind: 'portal_confirmation',
        to: to.email,
        locale: to.locale,
        ticketKey,
        trackingUrl: await this.link(tx, ticket, ticketKey, to),
        expectedFirstResponseAt: ticket.firstResponseDueAt?.toISOString() ?? null,
        ...formChoices(ticket),
      },
      `portal-confirm-${ticket.id}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /**
   * "We got your reply", sent after the customer answers from the portal. The reply came through
   * a tracking link, so the address is the one that holds the link; staff replies never come
   * here. The caller throttles per ticket so a burst of replies is one email, not a stream.
   */
  async replyReceived(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    message: MessageRow,
  ): Promise<void> {
    const to = await this.recipient(tx, ticket);
    if (!to) return;
    await this.outbox.send(
      {
        kind: 'portal_reply_received',
        to: to.email,
        locale: to.locale,
        ticketKey,
        trackingUrl: await this.link(tx, ticket, ticketKey, to),
      },
      `portal-reply-received-${message.id}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /** A public reply from staff. `ticket` is the ticket after the reply (and after any status change). */
  async staffReply(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    message: MessageRow,
  ): Promise<void> {
    const to = await this.recipient(tx, ticket);
    if (!to) return;
    let agent: string | null = null;
    if (message.senderUserId !== null) {
      const [user] = await tx
        .select({ name: schema.users.name })
        .from(schema.users)
        .where(eq(schema.users.id, message.senderUserId))
        .limit(1);
      agent = firstName(user?.name);
    }
    await this.outbox.send(
      {
        kind: 'portal_update',
        to: to.email,
        locale: to.locale,
        ticketKey,
        subject: oneLine(ticket.subject),
        trackingUrl: await this.link(tx, ticket, ticketKey, to),
        reason: 'staff_reply',
        status: customerStatus(ticket.status as TicketStatus),
        agentName: agent,
      },
      `portal-reply-${message.id}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /**
   * A status change the customer can see. Moving between `triage`, `open` and `waiting_on_dev` all
   * read "In progress", so those send nothing. A change the customer caused (their own reply
   * reopening the ticket) is not reported back to them.
   */
  async statusChange(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    from: TicketStatus,
    to: TicketStatus,
  ): Promise<void> {
    const before: CustomerStatus = customerStatus(from);
    const after: CustomerStatus = customerStatus(to);
    if (before === after || after === 'merged') return;
    const recipient = await this.recipient(tx, ticket);
    if (!recipient) return;
    // A closed ticket's links were revoked (`closeLinks`), so the notice must not mint a new one:
    // it points at the plain ticket page, and the customer can ask for a link there by email.
    const trackingUrl =
      after === 'closed'
        ? this.plainUrl(ticketKey)
        : await this.link(tx, ticket, ticketKey, recipient);
    await this.outbox.send(
      {
        kind: 'portal_update',
        to: recipient.email,
        locale: recipient.locale,
        ticketKey,
        subject: oneLine(ticket.subject),
        trackingUrl,
        reason: 'status_change',
        status: after,
        agentName: null,
      },
      `portal-status-${ticket.id}-${randomUUID()}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /** The customer of a merged ticket learns which ticket carries the conversation now (R-1.5). */
  async merged(
    tx: DbTransaction,
    source: TicketRow,
    sourceKey: string,
    intoKey: string,
  ): Promise<void> {
    const to = await this.recipient(tx, source);
    if (!to) return;
    await this.outbox.send(
      {
        kind: 'portal_merged',
        to: to.email,
        locale: to.locale,
        ticketKey: sourceKey,
        subject: oneLine(source.subject),
        intoKey,
        trackingUrl: await this.link(tx, source, sourceKey, to),
      },
      `portal-merged-${source.id}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /** A new tracking link, asked for with the ticket number and the address (`/v1/portal/track/resend`). */
  async resendLink(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    to: Recipient,
  ): Promise<void> {
    await this.outbox.send(
      {
        kind: 'portal_link',
        to: to.email,
        locale: to.locale,
        ticketKey,
        trackingUrl: await this.link(tx, ticket, ticketKey, to),
      },
      `portal-link-${randomUUID()}`,
      tx,
      PORTAL_EMAIL_TTL_SECONDS,
    );
  }

  /**
   * A ticket was closed: every tracking link it has stops working (C-13). A closed ticket is
   * final, so a link that leaks later (a forwarded email, a shared screen) must not stay a key to
   * its conversation. The requester can still ask for a fresh link by email, which proves they
   * hold the mailbox.
   */
  async closeLinks(tx: DbTransaction, ticketId: string): Promise<number> {
    return this.tokens.revokeForTicket(tx, ticketId);
  }

  /** Who the portal emails for this ticket: its requester, in their language. Null when none. */
  async recipient(tx: DbTransaction, ticket: TicketRow): Promise<Recipient | null> {
    if (ticket.channel !== 'portal' || ticket.requesterContactId === null) return null;
    const [contact] = await tx
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, ticket.requesterContactId))
      .limit(1);
    const email = contact?.emails[0];
    if (!contact || email === undefined) return null;
    return { contactId: contact.id, email, locale: localeOf(contact.notificationPrefs, ticket) };
  }

  /** The ticket page with no token: opening it asks for a new link. */
  private plainUrl(ticketKey: string): string {
    return new URL(portalTrackingPath(ticketKey), this.config.APP_URL).toString();
  }

  private async link(
    tx: DbTransaction,
    ticket: TicketRow,
    ticketKey: string,
    to: Recipient,
  ): Promise<string> {
    const { token } = await this.tokens.issue(tx, ticket.id, to.contactId);
    const url = new URL(portalTrackingPath(ticketKey), this.config.APP_URL);
    // The fragment never reaches a server or a log; the page reads it and sends it in a header.
    url.hash = `${PORTAL_TOKEN_FRAGMENT_KEY}=${token}`;
    return url.toString();
  }
}

/** The topic and urgency the customer picked on the form: fixed choices only, never their text. */
function formChoices(ticket: TicketRow) {
  const custom: unknown = ticket.customFields;
  const portal =
    typeof custom === 'object' && custom !== null && 'portal' in custom ? custom.portal : undefined;
  const field = (name: string): unknown =>
    typeof portal === 'object' && portal !== null && name in portal
      ? (portal as Record<string, unknown>)[name]
      : undefined;
  const category = portalCategorySchema.safeParse(field('category'));
  const urgency = portalUrgencySchema.safeParse(field('urgency'));
  return {
    category: category.success ? category.data : null,
    urgency: urgency.success ? urgency.data : null,
  };
}

/** Contact preference first, then the language of the form it was submitted in, then English `[ASSUMED]`. */
function localeOf(preferences: unknown, ticket: TicketRow): PortalLocale {
  const fromContact = portalLocaleSchema.safeParse(
    typeof preferences === 'object' && preferences !== null && 'locale' in preferences
      ? preferences.locale
      : undefined,
  );
  if (fromContact.success) return fromContact.data;
  const custom: unknown = ticket.customFields;
  const portal =
    typeof custom === 'object' && custom !== null && 'portal' in custom ? custom.portal : undefined;
  const fromTicket = portalLocaleSchema.safeParse(
    typeof portal === 'object' && portal !== null && 'locale' in portal ? portal.locale : undefined,
  );
  return fromTicket.success ? fromTicket.data : DEFAULT_PORTAL_LOCALE;
}
