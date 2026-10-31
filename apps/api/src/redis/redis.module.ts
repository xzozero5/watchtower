import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { parseRedisUrl } from '@watchtower/shared';
import { Redis } from 'ioredis';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/** DI token for the shared ioredis client (health checks now; pub/sub fan-out from T-005). */
export const REDIS = Symbol('REDIS');

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => {
      this.redis.disconnect();
    });
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: ApiConfig, logger: AppLogger): Redis => {
        const redis = new Redis({
          ...parseRedisUrl(config.REDIS_URL),
          connectionName: config.OTEL_SERVICE_NAME,
          maxRetriesPerRequest: 2,
        });
        redis.on('error', (error: Error) => {
          logger.error({ err: error }, 'redis connection error');
        });
        return redis;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
