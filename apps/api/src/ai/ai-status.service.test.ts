import { AI_STATUS_REDIS_KEY } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { AiStatusService } from './ai-status.service.js';

function make(provider: 'mock' | 'claude-cli', get: () => Promise<string | null>) {
  const redis = { get: vi.fn(get) };
  const service = new AiStatusService(redis, { AI_PROVIDER: provider });
  let clock = 1_000;
  service.now = () => clock;
  return { service, redis, tick: (ms: number) => (clock += ms) };
}

describe('AiStatusService (T-170)', () => {
  it('is disabled for mock and never reads Redis', async () => {
    const { service, redis } = make('mock', () => Promise.resolve(null));
    expect(await service.status()).toEqual({ status: 'disabled', checkedAt: null });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns what the worker reported', async () => {
    const report = { status: 'online', checkedAt: '2026-11-04T01:00:00.000Z' };
    const { service, redis } = make('claude-cli', () => Promise.resolve(JSON.stringify(report)));
    expect(await service.status()).toEqual(report);
    expect(redis.get).toHaveBeenCalledWith(AI_STATUS_REDIS_KEY);
  });

  it('is offline when there is no report, a bad report or Redis fails', async () => {
    expect((await make('claude-cli', () => Promise.resolve(null)).service.status()).status).toBe(
      'offline',
    );
    expect(
      (await make('claude-cli', () => Promise.resolve('{"status":"bogus"}')).service.status())
        .status,
    ).toBe('offline');
    expect(
      (await make('claude-cli', () => Promise.reject(new Error('down'))).service.status()).status,
    ).toBe('offline');
  });

  it('caches for a few seconds', async () => {
    const { service, redis, tick } = make('claude-cli', () => Promise.resolve(null));
    await service.status();
    tick(1000);
    await service.status();
    expect(redis.get).toHaveBeenCalledTimes(1);
    tick(6000);
    await service.status();
    expect(redis.get).toHaveBeenCalledTimes(2);
  });
});
