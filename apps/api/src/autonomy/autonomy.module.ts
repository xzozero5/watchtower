import { Module } from '@nestjs/common';

import { AutonomyController } from './autonomy.controller.js';
import { AutonomyService } from './autonomy.service.js';
import { IntentAutonomyController } from './intent-autonomy.controller.js';
import { IntentPromotionController, PromotionDecisionController } from './promotion.controller.js';

/**
 * Autonomy stage per intent and the emergency switches (T-112a, ADR-011). The policy gate itself is
 * built in `DomainModule`; this module is the HTTP surface for reading and changing the state.
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts` (none here).
 */
@Module({
  controllers: [
    AutonomyController,
    IntentAutonomyController,
    IntentPromotionController,
    PromotionDecisionController,
  ],
  providers: [AutonomyService],
})
export class AutonomyModule {}
