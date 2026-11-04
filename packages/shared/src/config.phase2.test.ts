import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createEnvSchema, parseEnv, phase2EnvShape } from './config.js';

// Phase 2 variables (T-200): every integration one is optional and empty means mock; the status page
// is closed unless the owner opens it; .env.example lists them all with the safe value.

const schema = createEnvSchema({});
const BASE = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'b',
  S3_ACCESS_KEY: 'k',
  S3_SECRET_KEY: 's',
  JWT_SECRET: 'change-me',
  APP_ENCRYPTION_KEY: 'change-me-32-bytes-base64',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};

const parse = (overrides: Record<string, string | undefined> = {}) =>
  parseEnv(schema, { ...BASE, ...overrides });

describe('Phase 2 variables', () => {
  it('are all optional: a configuration without them is valid and in mock mode', () => {
    const config = parse();
    expect(config.ALERT_PUSH_AUDIENCE).toBeUndefined();
    expect(config.ALERT_PUSH_SERVICE_ACCOUNT).toBeUndefined();
    expect(config.ALERT_WEBHOOK_SECRET).toBeUndefined();
  });

  it('the status page is closed by default, and an empty value is the default too', () => {
    expect(parse().STATUS_PAGE_PUBLIC).toBe(false);
    expect(parse({ STATUS_PAGE_PUBLIC: '' }).STATUS_PAGE_PUBLIC).toBe(false);
    expect(parse({ STATUS_PAGE_PUBLIC: 'false' }).STATUS_PAGE_PUBLIC).toBe(false);
  });

  it('ad-hoc data statements are off by default and open only on an explicit true (T-207a C-1)', () => {
    expect(parse().PRODUCT_DB_ADHOC_ENABLED).toBe(false);
    expect(parse({ PRODUCT_DB_ADHOC_ENABLED: '' }).PRODUCT_DB_ADHOC_ENABLED).toBe(false);
    expect(parse({ PRODUCT_DB_ADHOC_ENABLED: 'true' }).PRODUCT_DB_ADHOC_ENABLED).toBe(true);
    expect(() => parse({ PRODUCT_DB_ADHOC_ENABLED: 'maybe' })).toThrow();
  });

  it('the status page opens only on an explicit true', () => {
    expect(parse({ STATUS_PAGE_PUBLIC: 'true' }).STATUS_PAGE_PUBLIC).toBe(true);
    expect(() => parse({ STATUS_PAGE_PUBLIC: 'maybe' })).toThrow();
  });

  it('.env.example lists every Phase 2 variable, with the closed or empty value', () => {
    const example = parseDotenv(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    for (const name of Object.keys(phase2EnvShape)) {
      expect(Object.hasOwn(example, name), name).toBe(true);
    }
    expect(example.STATUS_PAGE_PUBLIC).toBe('false');
    expect(example.ALERT_PUSH_AUDIENCE).toBe('');
    expect(example.ALERT_WEBHOOK_SECRET).toBe('');
    expect(example.ALERT_HEARTBEAT_SECRET).toBe('');
    expect(example.DEPLOY_WEBHOOK_SECRET).toBe('');
  });
});

describe('push audiences (T-114a C-5)', () => {
  it('refuses a Gmail push audience equal to the alert one', () => {
    expect(() =>
      parse({ GMAIL_PUSH_AUDIENCE: 'same-audience', ALERT_PUSH_AUDIENCE: 'same-audience' }),
    ).toThrow(/GMAIL_PUSH_AUDIENCE/);
  });

  it('accepts different audiences, or only one of them', () => {
    expect(() =>
      parse({ GMAIL_PUSH_AUDIENCE: 'gmail-audience', ALERT_PUSH_AUDIENCE: 'alert-audience' }),
    ).not.toThrow();
    expect(() => parse({ GMAIL_PUSH_AUDIENCE: 'gmail-audience' })).not.toThrow();
  });
});
