import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '../ai/ai-runtime.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { ProceduresController } from './procedures.controller.js';
import { ProceduresService } from './procedures.service.js';
import { TicketProposalsController } from './ticket-proposals.controller.js';
import { TicketProposalsService } from './ticket-proposals.service.js';

/**
 * Procedures per intent (T-303b, ADR-026): routes under `/v1/intents/:id/procedure/versions`. The rules
 * are in `@watchtower/domain`, the compiler is the `procedure_compiler` agent of `@watchtower/ai`, run
 * through the api's audited, guarded runtime. The escalation cards of a ticket (T-303f) are under
 * `/v1/tickets/:id/procedure-proposals`. Every route needs `@RequirePermission` (none is public).
 */
@Module({
  imports: [AiRuntimeModule, TicketsModule],
  controllers: [ProceduresController, TicketProposalsController],
  providers: [ProceduresService, TicketProposalsService],
})
export class ProceduresModule {}
