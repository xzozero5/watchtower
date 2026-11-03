import { Module } from '@nestjs/common';

import { IntentsModule } from '../intents/intents.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { PortalNotificationsModule } from '../portal/portal-notifications.module.js';
import { SlaModule } from '../sla/sla.module.js';
import { TeamQueuesModule } from '../team-queues/team-queues.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { TICKET_KEYS, TicketKeys } from './ticket-keys.js';
import { SlaRemaining } from './sla-remaining.js';
import { TicketSlaStates } from './sla-states.js';
import { TicketAttachmentsController } from './ticket-attachments.controller.js';
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
  imports: [
    OrgsModule,
    IntentsModule,
    SlaModule,
    TeamQueuesModule,
    PortalNotificationsModule,
    UploadsModule,
  ],
  controllers: [TicketsController, TicketAttachmentsController, WorkflowController],
  providers: [
    {
      provide: TICKET_KEYS,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) => new TicketKeys(config.TICKET_KEY_PREFIX),
    },
    TicketsService,
    TicketSlaStates,
    SlaRemaining,
    TicketReader,
    TimelineService,
    WorkflowService,
  ],
  exports: [
    TICKET_KEYS,
    TicketsService,
    TicketReader,
    SlaRemaining,
    TimelineService,
    WorkflowService,
  ],
})
export class TicketsModule {}
