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

  it('reads the outbox poll interval: default 1 s, bounded', () => {
    expect(loadConfig(testEnv()).OUTBOX_POLL_INTERVAL_MS).toBe(1000);
    expect(loadConfig(testEnv({ OUTBOX_POLL_INTERVAL_MS: '250' })).OUTBOX_POLL_INTERVAL_MS).toBe(
      250,
    );
    expect(() => loadConfig(testEnv({ OUTBOX_POLL_INTERVAL_MS: '10' }))).toThrow(
      /OUTBOX_POLL_INTERVAL_MS/,
    );
  });

  it('reads the cleanup retention: defaults 7 and 30 days, break-glass at least 1', () => {
    const config = loadConfig(testEnv());
    expect(config.CLEANUP_AUTH_RETENTION_DAYS).toBe(7);
    expect(config.CLEANUP_BREAK_GLASS_RETENTION_DAYS).toBe(30);
    expect(() => loadConfig(testEnv({ CLEANUP_BREAK_GLASS_RETENTION_DAYS: '0' }))).toThrow(
      /CLEANUP_BREAK_GLASS_RETENTION_DAYS/,
    );
  });

  it('reads the ticket key prefix like the api does: default OPS, upper-cased, validated', () => {
    expect(loadConfig(testEnv()).TICKET_KEY_PREFIX).toBe('OPS');
    expect(loadConfig(testEnv({ TICKET_KEY_PREFIX: 'ops2' })).TICKET_KEY_PREFIX).toBe('OPS2');
    expect(loadConfig(testEnv({ TICKET_KEY_PREFIX: '' })).TICKET_KEY_PREFIX).toBe('OPS');
    expect(() => loadConfig(testEnv({ TICKET_KEY_PREFIX: 'a-b' }))).toThrow(/TICKET_KEY_PREFIX/);
  });

  it('waits 3 s for the ingest classifier by default, within bounds', () => {
    expect(loadConfig(testEnv()).INGEST_CLASSIFIER_TIMEOUT_MS).toBe(3000);
    expect(
      loadConfig(testEnv({ INGEST_CLASSIFIER_TIMEOUT_MS: '500' })).INGEST_CLASSIFIER_TIMEOUT_MS,
    ).toBe(500);
    expect(() => loadConfig(testEnv({ INGEST_CLASSIFIER_TIMEOUT_MS: '5' }))).toThrow(
      /INGEST_CLASSIFIER_TIMEOUT_MS/,
    );
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
