import { Global, Module, type DynamicModule } from '@nestjs/common';
import { REALTIME_CHANNEL } from '@watchtower/shared';

import { RealtimeGateway } from './realtime.gateway.js';
import { REALTIME_CHANNEL_NAME, RealtimePublisher } from './realtime-publisher.js';
import { UnitOfWorkService } from './unit-of-work.js';

/**
 * Realtime fan-out (Redis pub/sub to WebSocket) and the unit of work that publishes after commit.
 * Global: any feature module can inject `UnitOfWorkService`.
 */
@Global()
@Module({})
export class RealtimeModule {
  /** `prefix` separates the pub/sub channel of one test run from another, as for the queues. */
  static forRoot(prefix?: string): DynamicModule {
    return {
      module: RealtimeModule,
      providers: [
        {
          provide: REALTIME_CHANNEL_NAME,
          useValue: prefix === undefined ? REALTIME_CHANNEL : `${REALTIME_CHANNEL}:${prefix}`,
        },
        RealtimePublisher,
        UnitOfWorkService,
        RealtimeGateway,
      ],
      exports: [RealtimePublisher, UnitOfWorkService],
    };
  }
}
