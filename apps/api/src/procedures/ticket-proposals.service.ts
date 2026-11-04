import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import type { ProcedureProposalApplied, ProcedureProposalList } from '@watchtower/shared';

import type { Principal } from '../auth/decorators.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { actorOf } from '../kb/kb-actor.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { TicketReader } from '../tickets/ticket-reader.js';

/**
 * The escalation cards of a ticket (T-303f, ADR-026 sections 7 and 10). Reading a card needs a ticket the caller
 * can see (404 otherwise); pressing one runs the domain's `applyEscalation` as the person who pressed, with the
 * ordinary ticket services, in one transaction.
 */
@Injectable()
export class TicketProposalsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(TicketReader) private readonly tickets: TicketReader,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  async list(
    ref: string,
    principal: Principal,
  ): Promise<{ ticketId: string; list: ProcedureProposalList }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    const items = await translating(() =>
      this.domain.procedures.proposals(this.database.db, ticket.t.id),
    );
    return { ticketId: ticket.t.id, list: { items } };
  }

  async apply(
    ref: string,
    proposalId: string,
    principal: Principal,
  ): Promise<{ ticketId: string; applied: ProcedureProposalApplied }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    const applied = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.procedures.applyEscalation(
            uow.tx,
            domainContext(this.domain, actorOf(principal)),
            { ref: ticket.t.id, proposalId },
          ),
        ),
      ),
    );
    return { ticketId: ticket.t.id, applied };
  }
}
