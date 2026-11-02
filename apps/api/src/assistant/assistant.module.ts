import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module.js';
import { AiRuntimeModule } from '../ai/ai-runtime.module.js';
import { KbModule } from '../kb/kb.module.js';
import { ShiftsModule } from '../shifts/shifts.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { ToolsModule } from '../tools/tools.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantProposals } from './assistant-proposals.js';
import { AssistantService } from './assistant.service.js';

/**
 * The AI assistant (T-134, ADR-017): routes under `/v1/assistant`. It reuses the readers and services
 * of the other modules, so it can see and do what the signed-in person can and nothing else. Every
 * route needs `@RequirePermission` (none is public).
 */
@Module({
  imports: [AiModule, AiRuntimeModule, KbModule, ShiftsModule, TicketsModule, ToolsModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantProposals],
})
export class AssistantModule {}
