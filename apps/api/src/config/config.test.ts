import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigError } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { testEnv } from '../testing/support.js';
import { loadConfig } from './config.js';

const productionEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
};

describe('loadConfig', () => {
  it('applies API defaults: loopback bind, port 4000, docs on outside production', () => {
    const config = loadConfig(testEnv());
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.listenPort).toBe(4000);
    expect(config.docsEnabled).toBe(true);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('lets PORT (Cloud Run) win over API_PORT, and ignores an empty PORT', () => {
    expect(loadConfig(testEnv({ API_PORT: '4001', PORT: '8080' })).listenPort).toBe(8080);
    expect(loadConfig(testEnv({ API_PORT: '4001', PORT: '' })).listenPort).toBe(4001);
  });

  it('turns docs off in production unless DOCS_ENABLED says otherwise', () => {
    expect(loadConfig(testEnv(productionEnv)).docsEnabled).toBe(false);
    expect(loadConfig(testEnv({ ...productionEnv, DOCS_ENABLED: 'true' })).docsEnabled).toBe(true);
    expect(loadConfig(testEnv({ DOCS_ENABLED: 'false' })).docsEnabled).toBe(false);
  });

  it('fails the boot when a required variable is missing', () => {
    expect(() => loadConfig(testEnv({ DATABASE_URL: undefined }))).toThrow(ConfigError);
    expect(() => loadConfig(testEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({})).toThrow(/REDIS_URL/);
  });

  it('refuses the example "change-me" values in production, naming the variables only', () => {
    let message = '';
    try {
      loadConfig(testEnv({ NODE_ENV: 'production' }));
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).toMatch(/APP_ENCRYPTION_KEY/);
    expect(message).toMatch(/placeholder/);
    expect(message).not.toContain('minio12345');
  });

  it('accepts a real production configuration', () => {
    expect(loadConfig(testEnv(productionEnv)).NODE_ENV).toBe('production');
  });

  it('accepts .env.example as a development configuration', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(loadConfig(example).NODE_ENV).toBe('development');
  });
});
