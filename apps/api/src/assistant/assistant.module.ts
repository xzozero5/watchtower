import { Module } from '@nestjs/common';

import { AutonomyModule } from '../autonomy/autonomy.module.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { DashboardModule } from '../dashboard/dashboard.module.js';
import { InboundModule } from '../inbound/inbound.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { SlaModule } from '../sla/sla.module.js';
import { TeamQueuesModule } from '../team-queues/team-queues.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AiRuntimeModule } from '../ai/ai-runtime.module.js';
import { AlertsModule } from '../alerts/alerts.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { IntentsModule } from '../intents/intents.module.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { KbModule } from '../kb/kb.module.js';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantProposals } from './assistant-proposals.js';
import { ContextResolver } from './context-resolver.js';
import { AssistantService } from './assistant.service.js';
import { AssistantReadServices } from './tools/read-services.js';

/**
 * The AI assistant (T-134, ADR-023): routes under `/v1/assistant`. It reuses the readers and services
 * of the other modules, so it can see and do what the signed-in person can and nothing else. Every
 * route needs `@RequirePermission` (none is public).
 */
@Module({
  imports: [
    AiModule,
    AiRuntimeModule,
    AlertsModule,
    AutonomyModule,
    CredentialsModule,
    DashboardModule,
    InboundModule,
    IncidentsModule,
    IntentsModule,
    KbModule,
    OrgsModule,
    ReportsModule,
    ShiftsModule,
    SlaModule,
    TeamQueuesModule,
    TicketsModule,
    ToolsModule,
  ],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantProposals, ContextResolver, AssistantReadServices],
})
export class AssistantModule {}
