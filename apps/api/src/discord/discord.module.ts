import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module.js';
import { DiscordInteractionsController } from './interactions.controller.js';
import { DiscordInteractionsService } from './interactions.service.js';

/**
 * Discord: the interactions endpoint of the bot (T-202b: buttons, `/ack`, `/incident`). One-way
 * notifications are posted by the worker (T-104). Every route needs `@RequirePermission` /
 * `@RequireAnyPermission` or `@Public()`, and a public one must also be listed in
 * `./public-routes.ts`.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [DiscordInteractionsController],
  providers: [DiscordInteractionsService],
})
export class DiscordModule {}
