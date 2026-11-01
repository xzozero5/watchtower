import { Module } from '@nestjs/common';

import { TicketsModule } from '../tickets/tickets.module.js';
import { BulkService } from './bulk.service.js';
import { BulkController, LinksController } from './bulk-links.controller.js';
import { LinksService } from './links.service.js';
import { ViewsController } from './views.controller.js';
import { ViewsService } from './views.service.js';

/**
 * Saved views (`/v1/views`), bulk actions (`POST /v1/tickets/bulk`) and links between tickets
 * (`/v1/tickets/:id/links`), T-119. Bulk and links go through `TicketsService` / `TicketReader`, so
 * they follow the rules of the single routes. Every route needs `@RequirePermission` /
 * `@RequireAnyPermission` or `@Public()`, and a public one must also be listed in `./public-routes.ts`
 * (none here).
 */
@Module({
  imports: [TicketsModule],
  controllers: [ViewsController, BulkController, LinksController],
  providers: [ViewsService, BulkService, LinksService],
})
export class ViewsModule {}
