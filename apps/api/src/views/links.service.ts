import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  VIEWS_TICKET_EVENTS,
  TICKET_PAIR_LINK_KINDS,
  type CreateTicketLink,
  type TicketLink,
  type TicketPairLinkKind,
  type TicketLinkList,
  type TicketLinkRelation,
  type TicketPriority,
  type TicketStatus,
} from '@watchtower/shared';
import { and, asc, eq, inArray, or } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { PG, isPgError } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService, type DbTransaction } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader } from '../tickets/ticket-reader.js';

/**
 * Links between tickets (T-119c, PRD R-1.1): `duplicate` ("this ticket is a duplicate of that one")
 * and `related`. Different from merge: nothing is combined, both tickets stay open and keep their own
 * conversation and SLA; a link is a pointer staff can follow. Staff only, and both tickets must
 * belong to the same organization (one organization's tickets are never pointed at from another's).
 * Linking and unlinking write an internal event on both tickets and an audit row.
 */
@Injectable()
export class LinksService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  private async linksOf(
    executor: Pick<Database['db'], 'select'>,
    ticketId: string,
    onlyLinkId?: string,
  ): Promise<TicketLink[]> {
    const { ticketLink, ticket, users } = schema;
    const rows = await executor
      .select({ link: ticketLink, creatorName: users.name })
      .from(ticketLink)
      .leftJoin(users, eq(users.id, ticketLink.createdBy))
      .where(
        and(
          // Links to an incident or a deploy (T-137) are a different list: they have no other ticket.
          inArray(ticketLink.kind, [...TICKET_PAIR_LINK_KINDS]),
          or(eq(ticketLink.fromTicketId, ticketId), eq(ticketLink.toTicketId, ticketId)),
          onlyLinkId === undefined ? undefined : eq(ticketLink.id, onlyLinkId),
        ),
      )
      .orderBy(asc(ticketLink.createdAt), asc(ticketLink.id));
    if (rows.length === 0) return [];
    const otherIds = rows.flatMap(({ link }) => {
      const otherId = link.fromTicketId === ticketId ? link.toTicketId : link.fromTicketId;
      return otherId === null ? [] : [otherId];
    });
    const others = await executor
      .select({
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
      })
      .from(ticket)
      .where(inArray(ticket.id, otherIds));
    const byId = new Map(others.map((other) => [other.id, other]));
    const items: TicketLink[] = [];
    for (const { link, creatorName } of rows) {
      const outgoing = link.fromTicketId === ticketId;
      const otherId = outgoing ? link.toTicketId : link.fromTicketId;
      const other = otherId === null ? undefined : byId.get(otherId);
      if (other === undefined) continue;
      const kind = link.kind as TicketPairLinkKind;
      const relation: TicketLinkRelation =
        kind === 'related' ? 'related' : outgoing ? 'duplicate_of' : 'has_duplicate';
      items.push({
        id: link.id,
        kind,
        relation,
        ticket: {
          id: other.id,
          key: this.keys.format(other.number),
          subject: other.subject,
          status: other.status as TicketStatus,
          priority: other.priority as TicketPriority,
        },
        createdAt: link.createdAt.toISOString(),
        createdBy:
          link.createdBy !== null && creatorName !== null
            ? { id: link.createdBy, name: creatorName }
            : null,
      });
    }
    return items;
  }

  async list(ref: string, principal: Principal): Promise<TicketLinkList> {
    const view = await this.reader.viewRow(ref, principal);
    return { items: await this.linksOf(this.database.db, view.t.id) };
  }

  async create(ref: string, input: CreateTicketLink, principal: Principal): Promise<TicketLink> {
    try {
      return await this.uow.run(async ({ tx }) => {
        const source = await this.reader.viewRow(ref, principal, tx);
        const other = await this.reader.viewRow(input.ticketId, principal, tx);
        if (source.t.id === other.t.id) throw badRequest('A ticket cannot be linked to itself');
        if (source.t.orgId !== other.t.orgId) {
          throw conflict('Tickets of different organizations cannot be linked');
        }
        // `duplicate` points from the duplicate to the original; `related` is stored smaller id first.
        const [from, to] =
          input.kind === 'related' && source.t.id > other.t.id
            ? [other.t.id, source.t.id]
            : [source.t.id, other.t.id];
        if (input.kind === 'duplicate') {
          const [reverse] = await tx
            .select({ id: schema.ticketLink.id })
            .from(schema.ticketLink)
            .where(
              and(
                eq(schema.ticketLink.kind, 'duplicate'),
                eq(schema.ticketLink.fromTicketId, to),
                eq(schema.ticketLink.toTicketId, from),
              ),
            )
            .limit(1);
          if (reverse)
            throw conflict('The other ticket is already marked as a duplicate of this one');
        }
        const [link] = await tx
          .insert(schema.ticketLink)
          .values({
            kind: input.kind,
            fromTicketId: from,
            toTicketId: to,
            createdBy: principal.userId,
          })
          .returning();
        if (!link) throw new Error('ticket_link insert returned no row');

        await this.recordEvents(
          tx,
          VIEWS_TICKET_EVENTS.linked,
          link.id,
          input.kind,
          source,
          other,
          principal,
        );
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: principal.userId },
          action: AUDIT_ACTIONS.ticketLink,
          targetType: 'ticket',
          targetId: source.t.id,
          metadata: { linkId: link.id, kind: input.kind, otherTicketId: other.t.id },
        });
        const [created] = await this.linksOf(tx, source.t.id, link.id);
        if (!created) throw new Error('the link vanished');
        return created;
      });
    } catch (error) {
      if (isPgError(error, PG.uniqueViolation)) throw conflict('These tickets are already linked');
      throw error;
    }
  }

  async remove(ref: string, linkId: string, principal: Principal): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const source = await this.reader.viewRow(ref, principal, tx);
      const { ticketLink } = schema;
      // One statement finds and removes it, so two people removing the same link cannot both succeed.
      const [link] = await tx
        .delete(ticketLink)
        .where(
          and(
            eq(ticketLink.id, linkId),
            inArray(ticketLink.kind, [...TICKET_PAIR_LINK_KINDS]),
            or(eq(ticketLink.fromTicketId, source.t.id), eq(ticketLink.toTicketId, source.t.id)),
          ),
        )
        .returning();
      if (!link) throw notFound('No such link on this ticket');
      const otherId = link.fromTicketId === source.t.id ? link.toTicketId : link.fromTicketId;
      if (otherId === null) throw notFound('No such link on this ticket');
      const other = await this.reader.viewById(otherId, principal, tx);
      await this.recordEvents(
        tx,
        VIEWS_TICKET_EVENTS.unlinked,
        link.id,
        link.kind as TicketPairLinkKind,
        source,
        other,
        principal,
      );
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: principal.userId },
        action: AUDIT_ACTIONS.ticketUnlink,
        targetType: 'ticket',
        targetId: source.t.id,
        metadata: { linkId: link.id, kind: link.kind, otherTicketId: other.t.id },
      });
    });
  }

  /** One internal event on each of the two tickets: ids and keys, no subject. */
  private async recordEvents(
    tx: DbTransaction,
    type: string,
    linkId: string,
    kind: TicketPairLinkKind,
    source: { readonly t: { readonly id: string; readonly number: number } },
    other: { readonly t: { readonly id: string; readonly number: number } },
    principal: Principal,
  ): Promise<void> {
    const rows = [
      { ticketId: source.t.id, peer: other.t },
      { ticketId: other.t.id, peer: source.t },
    ];
    await tx.insert(schema.ticketEvent).values(
      rows.map(({ ticketId, peer }) => ({
        ticketId,
        type,
        actorType: 'user' as const,
        actorId: principal.userId,
        visibility: 'internal' as const,
        payload: {
          linkId,
          kind,
          otherTicketId: peer.id,
          otherTicketKey: this.keys.format(peer.number),
        },
      })),
    );
  }
}
