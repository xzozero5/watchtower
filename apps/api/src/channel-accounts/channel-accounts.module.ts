import { Module } from '@nestjs/common';

import { CredentialsModule } from '../credentials/credentials.module.js';
import { ChannelAccountsController } from './channel-accounts.controller.js';
import { ChannelAccountsService } from './channel-accounts.service.js';

/** LINE Official Accounts and Gmail mailboxes, head only (T-131): `/v1/admin/channel-accounts`. */
@Module({
  imports: [CredentialsModule],
  controllers: [ChannelAccountsController],
  providers: [ChannelAccountsService],
})
export class ChannelAccountsModule {}
