import { Module } from '@nestjs/common';

import { IntentsModule } from '../intents/intents.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { SlaModule } from '../sla/sla.module.js';
import { TeamQueuesModule } from '../team-queues/team-queues.module.js';
import { TicketReader } from './ticket-reader.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsService } from './tickets.service.js';
import { TimelineService } from './timeline.service.js';
import { WorkflowController, WorkflowService } from './workflow.service.js';

/**
 * Tickets (PRD section 4.1): create, list and search, status workflow, SLA, assignment, merge,
 * replies, notes and the timeline. `TicketsService` is exported so the portal channel (T-007) can
 * create a ticket inside its own transaction (`UnitOfWorkService.run`).
 */
@Module({
  imports: [OrgsModule, IntentsModule, SlaModule, TeamQueuesModule],
  controllers: [TicketsController, WorkflowController],
  providers: [TicketsService, TicketReader, TimelineService, WorkflowService],
  exports: [TicketsService, TicketReader, TimelineService, WorkflowService],
})
export class TicketsModule {}
