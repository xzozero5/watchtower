import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '../ai/ai-runtime.module.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { BriefService } from './brief.service.js';
import { HandoffController } from './handoff.controller.js';
import { HandoffReader } from './handoff-reader.js';
import { HandoffService } from './handoff.service.js';
import { RosterPlanController } from './roster-plan.controller.js';
import { RosterPlanService } from './roster-plan.service.js';
import { RosterController } from './roster.controller.js';
import { SHIFT_NOW } from './shift-core.js';
import { ShiftNotesController } from './shift-notes.controller.js';
import { ShiftNotes } from './shift-notes.service.js';
import { ShiftsController } from './shifts.controller.js';
import { ShiftsService } from './shifts.service.js';

/**
 * Shifts, roster, clock in/out, handoff, notes and the daily brief (T-111, PRD R-7.x, AC-7). Every
 * route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one must
 * also be listed in `./public-routes.ts` (none here). `SHIFT_NOW` is the clock; a test replaces it
 * to move time.
 */
@Module({
  imports: [TicketsModule, UploadsModule, AiRuntimeModule],
  controllers: [
    RosterController,
    RosterPlanController,
    ShiftsController,
    HandoffController,
    ShiftNotesController,
  ],
  providers: [
    { provide: SHIFT_NOW, useValue: () => new Date() },
    ShiftsService,
    HandoffService,
    HandoffReader,
    ShiftNotes,
    BriefService,
    RosterPlanService,
  ],
  // The assistant (T-134) reads who is on shift through the same service as the assignee list.
  exports: [BriefService],
})
export class ShiftsModule {}
