import { Module, type DynamicModule } from '@nestjs/common';

import { AuditModule } from './audit/audit.module.js';
import type { OidcOptions } from './auth/google-oidc.service.js';
import { AuthModule } from './auth/auth.module.js';
import { AppConfigModule } from './config/config.module.js';
import type { ApiConfig } from './config/config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import type { AppLogger } from './logging/logger.js';
import { QueueModule } from './queue/queue.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';

/** Knobs for tests; production passes none. */
export interface AppOptions {
  /** BullMQ key prefix, so a test never shares jobs with another run. */
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
        AuditModule,
        RbacModule,
        AuthModule.forRoot(options.oidc),
        HealthModule,
      ],
    };
  }
}
