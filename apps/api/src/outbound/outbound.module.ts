import { Module } from '@nestjs/common';

import { OutboundController } from './outbound.controller.js';
import { OutboundService } from './outbound.service.js';
import { OutboxOpsController } from './outbox-ops.controller.js';
import { OutboxOpsService } from './outbox-ops.service.js';

/**
 * Outbound delivery endpoints (T-122d, ADR-010): undo a send and the undo-window setting. Sending
 * itself is the worker's dispatcher; a reply is scheduled inside `POST /v1/tickets/:id/replies`.
 * The head's view of the outbox (health, dead letters, resend) is `OutboxOpsController` (T-121a).
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts` (none here).
 */
@Module({
  controllers: [OutboundController, OutboxOpsController],
  providers: [OutboundService, OutboxOpsService],
})
export class OutboundModule {}
