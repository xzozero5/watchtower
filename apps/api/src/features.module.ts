import { Module } from '@nestjs/common';

import { InboundModule } from './inbound/inbound.module.js';
import { OutboundModule } from './outbound/outbound.module.js';
import { GmailModule } from './gmail/gmail.module.js';
import { LineModule } from './line/line.module.js';
import { DiscordModule } from './discord/discord.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { AiModule } from './ai/ai.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { KbModule } from './kb/kb.module.js';
import { CsatModule } from './csat/csat.module.js';
import { ShiftsModule } from './shifts/shifts.module.js';
import { AutonomyModule } from './autonomy/autonomy.module.js';
import { CredentialsModule } from './credentials/credentials.module.js';
import { ViewsModule } from './views/views.module.js';
import { ChannelAccountsModule } from './channel-accounts/channel-accounts.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { ToolsModule } from './tools/tools.module.js';
import { StatusPageModule } from './statuspage/statuspage.module.js';
import { UsageModule } from './usage/usage.module.js';

/**
 * The feature modules (Phase 1: T-123a; Phase 2 appends below), imported once so that parallel tasks add files inside
 * their own module and never edit `app.module.ts`. A new feature adds one line here.
 */
@Module({
  imports: [
    InboundModule,
    OutboundModule,
    GmailModule,
    LineModule,
    DiscordModule,
    NotificationsModule,
    AiModule,
    AssistantModule,
    KbModule,
    CsatModule,
    ShiftsModule,
    AutonomyModule,
    CredentialsModule,
    ViewsModule,
    ChannelAccountsModule,
    AlertsModule,
    IncidentsModule,
    ToolsModule,
    StatusPageModule,
    UsageModule,
  ],
})
export class FeaturesModule {}
