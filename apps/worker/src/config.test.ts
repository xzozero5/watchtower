import { ConfigError } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';
import { testEnv } from './testing/support.js';

describe('loadConfig', () => {
  it('applies defaults: loopback bind, health port 4100, concurrency 5', () => {
    const config = loadConfig(testEnv({ WORKER_PORT: undefined }));
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.listenPort).toBe(4100);
    expect(config.WORKER_CONCURRENCY).toBe(5);
    expect(config.OTEL_SERVICE_NAME).toBe('watchtower-worker');
  });

  it('lets PORT (Cloud Run) win over WORKER_PORT', () => {
    expect(loadConfig(testEnv({ WORKER_PORT: '4101', PORT: '8080' })).listenPort).toBe(8080);
  });

  it('fails the boot when a required variable is missing', () => {
    expect(() => loadConfig(testEnv({ REDIS_URL: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('refuses "change-me" placeholders in production', () => {
    expect(() => loadConfig(testEnv({ NODE_ENV: 'production' }))).toThrow(/placeholder/);
  });

  it('rejects an out-of-range concurrency', () => {
    expect(() => loadConfig(testEnv({ WORKER_CONCURRENCY: '0' }))).toThrow(/WORKER_CONCURRENCY/);
  });
});
