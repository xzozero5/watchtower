import { Module, type DynamicModule } from '@nestjs/common';

import { AppConfigModule } from './config/config.module.js';
import type { ApiConfig } from './config/config.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import type { AppLogger } from './logging/logger.js';
import { RedisModule } from './redis/redis.module.js';
import { TelemetryModule } from './telemetry/telemetry.module.js';

@Module({})
export class AppModule {
  /**
   * Config and logger are created before Nest starts (main.ts) so that a bad environment fails
   * with a readable message, then handed in here.
   */
  static forRoot(config: ApiConfig, logger: AppLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        LoggingModule.forRoot(logger),
        TelemetryModule,
        DatabaseModule,
        RedisModule,
        HealthModule,
      ],
    };
  }
}
