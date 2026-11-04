import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  CLIENT_HIDDEN_DELIVERY_STATUSES,
  CUSTOMER_STATUS_LABELS,
  PORTAL_TIMELINE_LIMIT,
  customerStatus,
  maskEmail,
  type PortalReply,
  type PortalReplyResult,
  type PortalTicketView,
  type TicketStatus,
} from '@watchtower/shared';
import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { invalidTrackingLink } from '../auth/http-errors.js';
import { EmailTagService } from '../audit/email-tag.service.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import type { TicketRow } from '../tickets/ticket-reader.js';
import { TicketsService } from '../tickets/tickets.service.js';
import {
  PortalAttachmentsService,
  type StoredAttachments,
  type UploadedFile,
} from './portal-attachments.service.js';
import { PortalLimits } from './portal-limits.js';
import { PortalNotifier } from './portal-notifier.js';
import { PortalTokensService } from './portal-tokens.service.js';
import {
  buildTimeline,
  canCustomerReply,
  type ViewEvent,
  type ViewMessage,
} from './portal-view.js';

interface TrackingContext {
  readonly ticket: TicketRow;
  readonly contactId: string;
  readonly accessExpiresAt: Date;
}

const PUBLIC_EVENT_TYPES = ['ticket.created', 'ticket.status_changed', 'ticket.merged'] as const;

/**
 * What a customer can do with a tracking link: read the public side of their ticket, answer it, and
 * ask for a new link. Everything starts from the token, which arrives in the `X-Portal-Token`
 * header (never a cookie, never a URL, never a log line).
 *
 * No enumeration: an unknown ticket number, a wrong token, an expired or revoked one, and a token
 * of another ticket all answer the same 401 and do the same lookups. A caller learns nothing about
 * which tickets exist.
 */
@Injectable()
export class PortalTrackingService implements OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PortalTokensService) private readonly tokens: PortalTokensService,
    @Inject(PortalLimits) private readonly limits: PortalLimits,
    @Inject(PortalNotifier) private readonly notifier: PortalNotifier,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(EmailTagService) private readonly tags: EmailTagService,
    @Inject(PortalAttachmentsService) private readonly attachments: PortalAttachmentsService,
  ) {}

  async view(
    token: string | undefined,
    ticketKey: string,
    ip: string | null,
  ): Promise<PortalTicketView> {
    const access = await this.access(token, ticketKey, ip);
    const { ticket } = access;
    const [contact] = await this.database.db
      .select({ emails: schema.contact.emails })
      .from(schema.contact)
      .where(eq(schema.contact.id, access.contactId))
      .limit(1);
    const email = contact?.emails[0];

    // Newest first with a bound, then reversed: a ticket with a very long history shows its end.
    const messageRows = await this.database.db
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        bodyText: schema.message.bodyText,
        attachments: schema.message.attachments,
        createdAt: schema.message.createdAt,
        staffName: schema.users.name,
      })
      .from(schema.message)
      .leftJoin(schema.users, eq(schema.users.id, schema.message.senderUserId))
      .where(
        and(
          eq(schema.message.ticketId, ticket.id),
          eq(schema.message.visibility, 'public'),
          // A reply that has not reached the customer is not theirs to see (ADR-010).
          notInArray(schema.message.deliveryStatus, [...CLIENT_HIDDEN_DELIVERY_STATUSES]),
        ),
      )
      .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
      .limit(PORTAL_TIMELINE_LIMIT + 1);
    const eventRows = await this.database.db
      .select({
        id: schema.ticketEvent.id,
        type: schema.ticketEvent.type,
        payload: schema.ticketEvent.payload,
        createdAt: schema.ticketEvent.createdAt,
      })
      .from(schema.ticketEvent)
      .where(
        and(
          eq(schema.ticketEvent.ticketId, ticket.id),
          eq(schema.ticketEvent.visibility, 'public'),
          inArray(schema.ticketEvent.type, [...PUBLIC_EVENT_TYPES]),
          // The events table is partitioned by month; no event is older than the ticket (a day of
          // slack for clock differences, as in the staff timeline).
          gte(
            schema.ticketEvent.createdAt,
            sql`${ticket.createdAt.toISOString()}::timestamptz - interval '1 day'`,
          ),
        ),
      )
      .orderBy(desc(schema.ticketEvent.createdAt), desc(schema.ticketEvent.id))
      .limit(PORTAL_TIMELINE_LIMIT + 1);

    const messages: ViewMessage[] = messageRows.map((row) => ({ ...row }));
    const events: ViewEvent[] = eventRows.map((row) => ({ ...row }));
    const timeline = buildTimeline(messages, events);
    const truncated =
      messageRows.length > PORTAL_TIMELINE_LIMIT || eventRows.length > PORTAL_TIMELINE_LIMIT;
    const shown = timeline.slice(-PORTAL_TIMELINE_LIMIT);

    const status = customerStatus(ticket.status as TicketStatus);
    return {
      key: this.keys.format(ticket.number),
      subject: ticket.subject,
      status,
      statusLabel: CUSTOMER_STATUS_LABELS[status],
      mergedIntoKey: await this.mergedIntoKey(ticket),
      maskedEmail: email === undefined ? null : maskEmail(email),
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
      expectedFirstResponseAt:
        ticket.firstRespondedAt === null && ticket.status !== 'merged'
          ? (ticket.firstResponseDueAt?.toISOString() ?? null)
          : null,
      canReply: canCustomerReply(ticket),
      timeline: shown,
      truncated: truncated || timeline.length > shown.length,
      accessExpiresAt: access.accessExpiresAt.toISOString(),
    };
  }

  /**
   * Checks the token for this ticket without doing anything else. The upload interceptor calls it
   * before it reads a multipart body, so a caller without a valid token never gets files buffered.
   * Same single 401 for every failure, and the same audit entry, as every other portal read.
   */
  async authorize(token: string | undefined, ticketKey: string, ip: string | null): Promise<void> {
    await this.access(token, ticketKey, ip);
  }

  async reply(
    token: string | undefined,
    ticketKey: string,
    input: PortalReply,
    ip: string | null,
    files: readonly UploadedFile[] = [],
  ): Promise<PortalReplyResult> {
    const access = await this.access(token, ticketKey, ip);
    // Only a caller who holds a valid token for this ticket gets its files looked at and stored.
    // The reply limits count after the files pass, so a bad file does not use up the customer's
    // allowance (the token check above has its own per-address limit).
    const prepared = this.attachments.prepare(files);
    await this.limits.enforce('reply-ip', ip ?? 'unknown');
    await this.limits.enforce('reply-ticket', access.ticket.id);
    const reservation = await this.attachments.reserve(prepared, {
      ip,
      email: `contact:${access.contactId}`,
      org: `org:${access.ticket.orgId}`,
    });
    let stored: StoredAttachments;
    try {
      stored = await this.attachments.put(prepared);
    } catch (error) {
      await reservation.refund();
      throw error;
    }

    let result;
    try {
      // Decided before the transaction (Redis, not Postgres): at most one confirmation per ticket
      // per window. A Redis failure rejects like the other limits do (fail closed).
      const confirm = await this.limits.hit('reply-confirm', access.ticket.id);
      result = await this.uow.run(async (uow) => {
        const replied = await this.tickets.reply(
          uow,
          access.ticket.id,
          { body: input.body },
          { kind: 'contact', contactId: access.contactId, orgId: access.ticket.orgId },
          { type: 'anonymous', id: access.contactId },
          stored.records,
        );
        if (confirm.allowed) {
          await this.notifier.replyReceived(
            uow.tx,
            replied.ticket,
            this.keys.format(replied.ticket.number),
            replied.message,
          );
        }
        return replied;
      });
    } catch (error) {
      // Nothing points at the stored objects unless the reply was saved.
      await this.attachments.discard(stored.keys);
      await reservation.refund();
      throw error;
    }
    if (stored.records.length > 0) {
      AuditScope.set({
        metadata: { attachmentCount: stored.records.length, attachmentBytes: stored.bytes },
      });
    }
    const status = customerStatus(result.ticket.status as TicketStatus);
    return {
      message: {
        id: result.message.id,
        from: 'customer',
        authorName: null,
        body: result.message.bodyText,
        ...(stored.view.length > 0 ? { attachments: [...stored.view] } : {}),
        createdAt: result.message.createdAt.toISOString(),
      },
      status,
      statusLabel: CUSTOMER_STATUS_LABELS[status],
    };
  }

  /**
   * Starts the work of a "send me a new link" request and returns at once, so the response and its
   * timing are the same whether or not the ticket exists and the address belongs to it. At most 3
   * emails per address per hour; beyond that the request is accepted and dropped.
   */
  requestNewLink(ticketKey: string, email: string, ip: string | null): void {
    AuditScope.set({ targetType: 'email', targetId: this.tags.tag(email) });
    const work = this.issueNewLink(ticketKey, email, ip).catch((error: unknown) => {
      this.logger.error({ err: error }, 'portal tracking link request failed');
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Resolves when every request started so far has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  /** Staff revoke every live tracking link of a ticket (a link that went to the wrong person). */
  async revokeLinks(tx: Parameters<PortalTokensService['revokeForTicket']>[0], ticketId: string) {
    return this.tokens.revokeForTicket(tx, ticketId);
  }

  private async issueNewLink(ticketKey: string, email: string, ip: string | null): Promise<void> {
    const allowed = await this.limits.hit('resend-email', email);
    if (!allowed.allowed) {
      this.logger.warn(
        { emailTag: this.tags.tag(email) },
        'portal link request limited for this address',
      );
      return;
    }
    const number = this.keys.parse(ticketKey);
    if (number === null) return;
    await this.database.db.transaction(async (tx) => {
      const [ticket] = await tx
        .select()
        .from(schema.ticket)
        .where(eq(schema.ticket.number, number))
        .limit(1);
      if (!ticket) return;
      const recipient = await this.notifier.recipient(tx, ticket);
      if (recipient?.email !== email.trim().toLowerCase()) return;
      await this.notifier.resendLink(tx, ticket, this.keys.format(ticket.number), recipient);
      // Written directly, not with recordInTransaction: this runs after the response, and must not
      // tell the request's interceptor that its own row is already written.
      await this.audit.record(
        {
          actor: { type: 'anonymous', id: recipient.contactId },
          action: AUDIT_ACTIONS.portalLinkIssued,
          targetType: 'ticket',
          targetId: ticket.id,
          ip,
          metadata: { emailTag: this.tags.tag(email) },
        },
        tx,
      );
    });
  }

  /** Authenticates the token for this ticket number. One failure answer for every reason. */
  private async access(
    token: string | undefined,
    ticketKey: string,
    ip: string | null,
  ): Promise<TrackingContext> {
    await this.limits.enforce('read-ip', ip ?? 'unknown');
    const number = this.keys.parse(ticketKey);
    const claims = await this.tokens.authenticate(token);
    // Asked even for a key that cannot be ours (-1 matches nothing), so the work is the same.
    const [ticket] = await this.database.db
      .select()
      .from(schema.ticket)
      .where(eq(schema.ticket.number, number ?? -1))
      .limit(1);
    if (
      !claims ||
      !ticket ||
      ticket.id !== claims.ticketId ||
      ticket.requesterContactId !== claims.contactId
    ) {
      AuditScope.set({ action: AUDIT_ACTIONS.portalAccessDenied, outcome: 'denied' });
      throw invalidTrackingLink();
    }
    return { ticket, contactId: claims.contactId, accessExpiresAt: claims.expiresAt };
  }

  private async mergedIntoKey(ticket: TicketRow): Promise<string | null> {
    if (ticket.status !== 'merged' || ticket.parentTicketId === null) return null;
    const [parent] = await this.database.db
      .select({ number: schema.ticket.number })
      .from(schema.ticket)
      .where(eq(schema.ticket.id, ticket.parentTicketId))
      .limit(1);
    return parent ? this.keys.format(parent.number) : null;
  }
}
