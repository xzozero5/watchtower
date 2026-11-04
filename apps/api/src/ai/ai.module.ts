import { Module } from '@nestjs/common';

import { TicketsModule } from '../tickets/tickets.module.js';
import { AiGradesController } from './ai-grades.controller.js';
import { AiGradesService } from './ai-grades.service.js';
import { AiStatusController } from './ai-status.controller.js';
import { AiStatusService } from './ai-status.service.js';
import { TicketAiController } from './ticket-ai.controller.js';
import { TicketAiService } from './ticket-ai.service.js';

/**
 * AI endpoints: the AI brief of a ticket (T-106e); runs, drafts and settings follow with T-108 and
 * T-116; grader results per intent (T-301). Every route needs `@RequirePermission` /
 * `@RequireAnyPermission` or `@Public()`, and a public one must also be listed in
 * `./public-routes.ts`; `app.module.ts` already imports this module through `features.module.ts`.
 */
@Module({
  imports: [TicketsModule],
  controllers: [TicketAiController, AiStatusController, AiGradesController],
  providers: [TicketAiService, AiStatusService, AiGradesService],
  // The assistant (T-134) asks for a draft through the same service as the button does.
  exports: [TicketAiService, AiStatusService],
})
export class AiModule {}
