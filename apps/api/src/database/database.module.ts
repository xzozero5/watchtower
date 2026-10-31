import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, type Database } from '@watchtower/db';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/** DI token for the Drizzle database handle (`Database` from @watchtower/db). */
export const DATABASE = Symbol('DATABASE');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: AppLogger): Database =>
        createDatabase({
          url: config.DATABASE_URL,
          applicationName: config.OTEL_SERVICE_NAME,
          onError: (error) => {
            logger.error({ err: error }, 'idle database connection failed');
          },
        }),
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
