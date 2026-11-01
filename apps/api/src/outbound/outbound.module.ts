import { Module } from '@nestjs/common';

import { OutboundController } from './outbound.controller.js';
import { OutboundService } from './outbound.service.js';

/**
 * Outbound delivery endpoints (T-122d, ADR-010): undo a send and the undo-window setting. Sending
 * itself is the worker's dispatcher; a reply is scheduled inside `POST /v1/tickets/:id/replies`.
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts` (none here). The dead-letter list belongs to T-121.
 */
@Module({
  controllers: [OutboundController],
  providers: [OutboundService],
})
export class OutboundModule {}
