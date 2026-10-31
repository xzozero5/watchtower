import { Module, type DynamicModule } from '@nestjs/common';

import { AuditModule } from './audit/audit.module.js';
import type { OidcOptions } from './auth/google-oidc.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AppConfigModule } from './config/config.module.js';
import type { ApiConfig } from './config/config.js';
import { DatabaseModule } from './database/database.module.js';
import { IntentsModule } from './intents/intents.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import type { AppLogger } from './logging/logger.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { RedisModule } from './redis/redis.module.js';
import { SlaModule } from './sla/sla.module.js';
import { TeamQueuesModule } from './team-queues/team-queues.module.js';
import { TicketsModule } from './tickets/tickets.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';

/** Knobs for tests; production passes none. */
export interface AppOptions {
  /** BullMQ key prefix and Redis pub/sub channel suffix, so a test never shares either with another run. */
  readonly queuePrefix?: string;
  /** Points Google sign-in at a local fake identity provider. */
  readonly oidc?: OidcOptions;
}

@Module({})
export class AppModule {
  /**
   * Config and logger are created before Nest starts (main.ts) so that a bad environment fails
   * with a readable message, then handed in here.
   */
  static forRoot(config: ApiConfig, logger: AppLogger, options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        LoggingModule.forRoot(logger),
        TelemetryModule,
        DatabaseModule,
        RedisModule,
        QueueModule.forRoot(options.queuePrefix),
        RealtimeModule.forRoot(options.queuePrefix),
        AuditModule,
        RbacModule,
        AuthModule.forRoot(options.oidc),
        OrgsModule,
        IntentsModule,
        SlaModule,
        TeamQueuesModule,
        TicketsModule,
        HealthModule,
      ],
    };
  }
}
