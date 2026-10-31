import { REALTIME_CHANNEL, type RealtimeEvent } from '@watchtower/shared';
import type { Redis } from 'ioredis';

/**
 * Realtime fan-out from the worker. Domain operations return `RealtimeEvent`s and the caller
 * publishes them after the commit (ADR-009); the api does the same through `RealtimePublisher`, on
 * the same Redis pub/sub channel, and every api instance forwards what it hears to its WebSocket
 * clients. Fire and forget: pub/sub keeps nothing for a listener that is not connected.
 */
export interface RealtimeSink {
  publish(event: RealtimeEvent): Promise<void>;
}

export function createRealtimeSink(redis: Pick<Redis, 'publish'>, channel?: string): RealtimeSink {
  const name = channel ?? REALTIME_CHANNEL;
  return {
    async publish(event) {
      await redis.publish(name, JSON.stringify(event));
    },
  };
}
