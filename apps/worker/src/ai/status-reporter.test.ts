import { AI_STATUS_REDIS_KEY, aiStatusSchema } from '@watchtower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeAiStatus, startAiStatusReporter } from './status-reporter.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe('probeAiStatus (T-170)', () => {
  it('mock is disabled and a real API provider is online without a probe', async () => {
    const fetch = vi.fn();
    expect(await probeAiStatus({ provider: 'mock', bridgeUrl: undefined, fetch })).toBe('disabled');
    expect(await probeAiStatus({ provider: 'anthropic', bridgeUrl: undefined, fetch })).toBe(
      'online',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('claude-cli follows the online flag of /healthz', async () => {
    const urls: string[] = [];
    const answer = (body: unknown, status?: number) => (url: string) => {
      urls.push(url);
      return Promise.resolve(json(body, status));
    };
    const base = { provider: 'claude-cli', bridgeUrl: 'http://claude-bridge:4317' } as const;
    expect(await probeAiStatus({ ...base, fetch: answer({ status: 'ok', online: true }) })).toBe(
      'online',
    );
    expect(await probeAiStatus({ ...base, fetch: answer({ status: 'ok', online: false }) })).toBe(
      'offline',
    );
    expect(await probeAiStatus({ ...base, fetch: answer({}, 500) })).toBe('offline');
    expect(await probeAiStatus({ ...base, fetch: answer({ nope: 1 }) })).toBe('offline');
    expect(urls[0]).toBe('http://claude-bridge:4317/healthz');
  });

  it('claude-cli is offline when the bridge cannot be reached', async () => {
    const fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(
      await probeAiStatus({
        provider: 'claude-cli',
        bridgeUrl: 'http://claude-bridge:4317',
        fetch,
      }),
    ).toBe('offline');
  });
});

describe('startAiStatusReporter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the status with a TTL, now and on every tick, without any URL', async () => {
    vi.useFakeTimers();
    const set = vi.fn(() => Promise.resolve('OK'));
    const logger = { warn: vi.fn() } as never;
    const reporter = startAiStatusReporter({
      probe: () => Promise.resolve('offline'),
      store: { set },
      logger,
      now: () => new Date('2026-11-04T01:00:00.000Z'),
      intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(2500);
    reporter.stop();
    expect(set.mock.calls.length).toBeGreaterThanOrEqual(3);
    const [key, value, mode, ttl] = set.mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe(AI_STATUS_REDIS_KEY);
    expect(mode).toBe('PX');
    expect(ttl).toBeGreaterThan(0);
    expect(aiStatusSchema.parse(JSON.parse(value))).toEqual({
      status: 'offline',
      checkedAt: '2026-11-04T01:00:00.000Z',
    });
    expect(value).not.toMatch(/http|token/i);
  });

  it('logs and keeps going when Redis fails', async () => {
    const warn = vi.fn();
    const reporter = startAiStatusReporter({
      probe: () => Promise.resolve('online'),
      store: { set: () => Promise.reject(new Error('down')) },
      logger: { warn } as never,
    });
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    reporter.stop();
  });
});
