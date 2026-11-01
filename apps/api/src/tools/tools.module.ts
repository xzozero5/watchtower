import { Module } from '@nestjs/common';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { StatusPanel } from './status-panel.service.js';
import { ToolTemplates } from './templates.service.js';
import { buildToolClients, TOOL_CLIENTS } from './tool-clients.js';
import { ToolRunner } from './tool-runner.service.js';
import {
  AdhocController,
  IncidentToolsController,
  OpsController,
  TicketToolsController,
  ToolTemplatesController,
} from './tools.controller.js';

/**
 * Investigation tools as a person uses them (T-203d, R-5.1 to R-5.7): saved templates per intent,
 * one-click runs on a ticket or an incident with evidence cards, ad-hoc runs for lead and head, and
 * the service status panel. All of it goes through read-only clients (`@watchtower/connectors`, N2)
 * and the shared rate budget. No live adapter exists before T-208: the clients are fakes over
 * `AI_TOOL_FIXTURES_DIR` and the product database behind `PRODUCT_DB_URL` (the local `product_mock`
 * in development). Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`.
 */
@Module({
  imports: [TicketsModule],
  controllers: [
    ToolTemplatesController,
    TicketToolsController,
    IncidentToolsController,
    AdhocController,
    OpsController,
  ],
  providers: [
    {
      provide: TOOL_CLIENTS,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) => buildToolClients(config),
    },
    ToolRunner,
    ToolTemplates,
    StatusPanel,
  ],
  exports: [ToolRunner],
})
export class ToolsModule {}
