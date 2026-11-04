import { Module } from '@nestjs/common';

import { TicketsModule } from '../tickets/tickets.module.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The ops dashboard read model (T-206b). One read-only route; it needs `dashboard.ops.read` and no route is
 * public.
 */
@Module({
  imports: [TicketsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
