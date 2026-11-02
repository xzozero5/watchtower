import { Inject, Injectable } from '@nestjs/common';
import {
  lockTicketRow,
  type CreateManualTicketResult,
  replyDeliveryStatus,
  type CreateTicketInput,
  type CreateTicketResult,
  type DomainContext,
  type MessageRow,
  type OutboundDeliveryRow,
  type Sender,
} from '@watchtower/domain';
import type {
  AssignTicket,
  CreateManualTicket,
  CreateTicketReference,
  MergeTicket,
  Note,
  Reply,
  TicketStatus,
  UpdateTicket,
} from '@watchtower/shared';

import type { AuditActor } from '../audit/audit-scope.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { PortalNotifier } from '../portal/portal-notifier.js';
import type { DbTransaction, UnitOfWork } from '../realtime/unit-of-work.js';
import type { TicketRow } from './ticket-reader.js';

export { replyDeliveryStatus, type CreateTicketResult, type Sender };

/** Who does something: written to the audit log and the ticket event log. */
export type Actor = AuditActor;

/** What it takes to open a ticket: the domain's `CreateTicketInput`, and who is doing it. */
export interface CreateTicketCommand extends CreateTicketInput {
  readonly actor: Actor;
}

/**
 * Everything that changes a ticket. Each method runs inside the caller's `UnitOfWork`, so the
 * ticket, its messages, its events and its audit entry commit together, and the realtime events go
 * out only after the commit. The portal channel (T-007) calls `create` in the same transaction as
 * its own work (a signed tracking token, and an email written to the transactional outbox in the
 * same transaction — ADR-006; never an enqueue in `uow.afterCommit`, which is lost if Redis is down).
 *
 * The logic itself lives in `@watchtower/domain` (ADR-009), shared with the worker. This class is
 * the Nest face of it: it builds the context (actor, request source, the portal's notices), hands
 * the domain's events and audit mark to the request, and answers the domain's refusals with the
 * api's HTTP errors.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(PortalNotifier) private readonly portal: PortalNotifier,
  ) {}

  private context(actor: Actor): DomainContext {
    return domainContext(this.domain, actor, this.portal);
  }

  async create(uow: UnitOfWork, command: CreateTicketCommand): Promise<CreateTicketResult> {
    const { actor, ...input } = command;
    return translating(async () =>
      settle(uow, await this.domain.tickets.create(uow.tx, this.context(actor), input)),
    );
  }

  async update(
    uow: UnitOfWork,
    ref: string,
    patch: UpdateTicket,
    actor: Actor,
  ): Promise<TicketRow> {
    return translating(async () =>
      settle(uow, await this.domain.tickets.update(uow.tx, this.context(actor), { ref, patch })),
    );
  }

  async changeStatus(
    uow: UnitOfWork,
    ref: string,
    status: TicketStatus,
    actor: Actor,
    reason?: string,
    asDev = false,
  ): Promise<TicketRow> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.changeStatus(uow.tx, this.context(actor), {
          ref,
          status,
          reason,
          asDev,
        }),
      ),
    );
  }

  /** A ticket filed by hand: contact, ticket, first message and the confirmation email (T-136). */
  async createManual(
    uow: UnitOfWork,
    input: CreateManualTicket,
    actor: Actor,
  ): Promise<CreateManualTicketResult> {
    return translating(async () =>
      settle(uow, await this.domain.tickets.createManual(uow.tx, this.context(actor), input)),
    );
  }

  /** The caller becomes the dev owner (T-137). */
  async devPickUp(uow: UnitOfWork, ref: string, actor: Actor): Promise<TicketRow> {
    return translating(async () =>
      settle(uow, await this.domain.tickets.devPickUp(uow.tx, this.context(actor), { ref })),
    );
  }

  async devRelease(uow: UnitOfWork, ref: string, actor: Actor): Promise<TicketRow> {
    return translating(async () =>
      settle(uow, await this.domain.tickets.devRelease(uow.tx, this.context(actor), { ref })),
    );
  }

  async referenceAdd(
    uow: UnitOfWork,
    ref: string,
    reference: CreateTicketReference,
    actor: Actor,
  ): Promise<{ ticket: TicketRow; linkId: string; created: boolean }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.referenceAdd(uow.tx, this.context(actor), { ref, reference }),
      ),
    );
  }

  async referenceRemove(
    uow: UnitOfWork,
    ref: string,
    linkId: string,
    actor: Actor,
  ): Promise<TicketRow> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.referenceRemove(uow.tx, this.context(actor), { ref, linkId }),
      ),
    );
  }

  async assign(
    uow: UnitOfWork,
    ref: string,
    input: AssignTicket,
    actor: Actor,
  ): Promise<TicketRow> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.assign(uow.tx, this.context(actor), { ref, assignment: input }),
      ),
    );
  }

  /**
   * Merges `ref` (the source) into `input.intoTicketId` (the target): the source becomes `merged`
   * and points at the target through `parent_ticket_id`. Refused when it would cross organizations
   * or form a loop.
   */
  async merge(
    uow: UnitOfWork,
    ref: string,
    input: MergeTicket,
    actor: Actor,
  ): Promise<{ source: TicketRow; target: TicketRow }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.merge(uow.tx, this.context(actor), { ref, merge: input }),
      ),
    );
  }

  /**
   * A public reply. Staff answer the customer (outbound; counts as the first response); a client
   * writes on a ticket of their own organization (inbound). A client's reply restarts a ticket that
   * waits on the customer and reopens one resolved in the last 7 days (R-1.10).
   */
  async reply(
    uow: UnitOfWork,
    ref: string,
    input: Reply,
    sender: Sender,
    actor: Actor,
  ): Promise<{ message: MessageRow; ticket: TicketRow; delivery?: OutboundDeliveryRow | null }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.reply(uow.tx, this.context(actor), {
          ref,
          reply: input,
          sender,
        }),
      ),
    );
  }

  /** An internal note: staff only, never sent, never visible to a client. */
  async note(
    uow: UnitOfWork,
    ref: string,
    input: Note,
    sender: { readonly userId: string },
    actor: Actor,
  ): Promise<{ message: MessageRow; ticket: TicketRow }> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.tickets.note(uow.tx, this.context(actor), { ref, note: input, sender }),
      ),
    );
  }

  /** Loads and locks a ticket for the rest of the transaction. */
  async lock(tx: DbTransaction, ref: string): Promise<TicketRow> {
    // A lookup needs only the key prefix, so the context carries no real actor.
    return translating(() => lockTicketRow(tx, this.context({ type: 'system', id: null }), ref));
  }
}
