import { Inject, Injectable } from '@nestjs/common';
import type { RealtimeEvent } from '@watchtower/shared';
import type { Redis } from 'ioredis';

import { REDIS } from '../redis/redis.module.js';

/** DI token for the Redis pub/sub channel name (a test adds a prefix so runs never share one). */
export const REALTIME_CHANNEL_NAME = Symbol('REALTIME_CHANNEL_NAME');

/**
 * Publishes realtime events on Redis pub/sub. Every api instance subscribes (RealtimeGateway) and
 * pushes to its own WebSocket clients, so a client gets the event whichever instance it is
 * connected to and whichever instance made the change.
 *
 * Fire and forget: pub/sub keeps nothing for a listener that is not connected, so a client that
 * reconnects refetches over REST. Call it after the transaction commits (`UnitOfWork.emit`).
 */
@Injectable()
export class RealtimePublisher {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(REALTIME_CHANNEL_NAME) private readonly channel: string,
  ) {}

  async publish(event: RealtimeEvent): Promise<void> {
    await this.redis.publish(this.channel, JSON.stringify(event));
  }
}
