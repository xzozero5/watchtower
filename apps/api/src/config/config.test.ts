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
  GOOGLE_OIDC_CLIENT_ID: 'client-id.example',
  GOOGLE_OIDC_CLIENT_SECRET: 'client-secret-value',
  GOOGLE_ALLOWED_DOMAIN: 'example.com',
};

describe('loadConfig', () => {
  it('applies API defaults: loopback bind, port 4000, docs on outside production', () => {
    const config = loadConfig(testEnv());
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.listenPort).toBe(4000);
    expect(config.docsEnabled).toBe(true);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('reads the ticket key prefix: default OPS, upper-cased, validated', () => {
    expect(loadConfig(testEnv()).TICKET_KEY_PREFIX).toBe('OPS');
    expect(loadConfig(testEnv({ TICKET_KEY_PREFIX: '' })).TICKET_KEY_PREFIX).toBe('OPS');
    expect(loadConfig(testEnv({ TICKET_KEY_PREFIX: 'sup2' })).TICKET_KEY_PREFIX).toBe('SUP2');
    for (const bad of ['S', '2UP', 'has space', 'WAYTOOLONGPREFIX', 'OPS-']) {
      expect(() => loadConfig(testEnv({ TICKET_KEY_PREFIX: bad }))).toThrow(/TICKET_KEY_PREFIX/);
    }
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

describe('auth configuration', () => {
  it('is in mock mode with dev login on when Google credentials are empty (outside production)', () => {
    const config = loadConfig(testEnv());
    expect(config.googleMode).toBe('mock');
    expect(config.devLoginEnabled).toBe(true);
    expect(config.staffDomain).toBe('example.com');
  });

  it('is live with dev login off once both Google credentials are set', () => {
    const live = {
      GOOGLE_OIDC_CLIENT_ID: 'id',
      GOOGLE_OIDC_CLIENT_SECRET: 'secret',
      GOOGLE_ALLOWED_DOMAIN: 'Corp.Example.com',
    };
    const config = loadConfig(testEnv(live));
    expect(config.googleMode).toBe('live');
    expect(config.devLoginEnabled).toBe(false);
    expect(config.staffDomain).toBe('corp.example.com');
  });

  it('treats one credential without the other as mock, never as live', () => {
    const config = loadConfig(
      testEnv({ GOOGLE_OIDC_CLIENT_ID: 'id', GOOGLE_ALLOWED_DOMAIN: 'example.com' }),
    );
    expect(config.googleMode).toBe('mock');
  });

  it('refuses to boot in production in mock mode, so dev login can never be reachable there', () => {
    expect(() =>
      loadConfig(
        testEnv({ ...productionEnv, GOOGLE_OIDC_CLIENT_ID: '', GOOGLE_OIDC_CLIENT_SECRET: '' }),
      ),
    ).toThrow(/mock sign-in is not allowed/);
    const production = loadConfig(testEnv(productionEnv));
    expect(production.googleMode).toBe('live');
    expect(production.devLoginEnabled).toBe(false);
  });

  it('marks cookies Secure in production and over https, not on plain local http', () => {
    expect(loadConfig(testEnv()).cookieSecure).toBe(false);
    expect(loadConfig(testEnv(productionEnv)).cookieSecure).toBe(true);
    expect(loadConfig(testEnv({ API_URL: 'https://api.example.com' })).cookieSecure).toBe(true);
  });

  it('has short-lived access tokens by default and bounds every lifetime', () => {
    const config = loadConfig(testEnv());
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(config.MAGIC_LINK_TTL_SECONDS).toBe(900);
    expect(config.REFRESH_TOKEN_TTL_SECONDS).toBeGreaterThan(config.ACCESS_TOKEN_TTL_SECONDS);
    expect(config.SESSION_MAX_AGE_SECONDS).toBeGreaterThan(config.REFRESH_TOKEN_TTL_SECONDS);
    expect(() => loadConfig(testEnv({ ACCESS_TOKEN_TTL_SECONDS: '86400' }))).toThrow(
      /ACCESS_TOKEN_TTL_SECONDS/,
    );
    expect(() => loadConfig(testEnv({ MAGIC_LINK_TTL_SECONDS: '604800' }))).toThrow(
      /MAGIC_LINK_TTL_SECONDS/,
    );
  });

  it('keeps break-glass credentials out of an error message', () => {
    let message = '';
    try {
      loadConfig(testEnv({ BREAK_GLASS_EMAIL: 'admin@example.com', BREAK_GLASS_PASSWORD: 'tiny' }));
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('BREAK_GLASS_PASSWORD');
    expect(message).not.toContain('tiny');
  });
});
