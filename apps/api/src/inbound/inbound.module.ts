import { Module } from '@nestjs/common';

import { OtherMailController } from './other-mail.controller.js';
import { OtherMailService } from './other-mail.service.js';

/**
 * Inbound webhook receivers and the other-mail log (T-122, T-102b, T-103b). The receivers are in the
 * channel modules; this one holds "Other mail" (T-119): list, read and "this is a ticket". Every
 * route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one must
 * also be listed in `./public-routes.ts`.
 */
@Module({
  controllers: [OtherMailController],
  providers: [OtherMailService],
  exports: [OtherMailService],
})
export class InboundModule {}
