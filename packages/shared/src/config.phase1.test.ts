import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { ConfigError, createEnvSchema, parseEnv, phase1EnvShape } from './config.js';

// Phase 1 variables (T-123a): every one optional, empty means mock, and .env.example lists them all.

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

describe('Phase 1 variables', () => {
  it('are all optional: a configuration without them is valid and in mock mode', () => {
    const config = parse();
    expect(config.PUBSUB_PROJECT_ID).toBeUndefined();
    expect(config.GMAIL_PUSH_AUDIENCE).toBeUndefined();
    expect(config.LINE_LOGIN_CHANNEL_ID).toBeUndefined();
    expect(config.DISCORD_PUBLIC_KEY).toBeUndefined();
    expect(config.DISCORD_APPLICATION_ID).toBeUndefined();
    expect(config.DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(config.WEB_PUSH_SUBJECT).toBeUndefined();
    expect(config.AI_DAILY_COST_CAP_USD).toBeUndefined();
    expect(config.AI_DAILY_TOKEN_CAP).toBeUndefined();
    expect(config.EMBEDDING_PROVIDER).toBe('mock');
    expect(config.KB_CRAWL_ALLOWED_HOSTS).toEqual([]);
    expect(config.OUTBOUND_UNDO_SECONDS).toBe(5);
    expect(config.AI_BUDGET_ALERT_PERCENT).toBe(80);
  });

  it('treats an empty value like an unset one', () => {
    const empty = Object.fromEntries(Object.keys(phase1EnvShape).map((key) => [key, '']));
    const config = parse(empty);
    expect(config.EMBEDDING_PROVIDER).toBe('mock');
    expect(config.KB_CRAWL_ALLOWED_HOSTS).toEqual([]);
    expect(config.OUTBOUND_UNDO_SECONDS).toBe(5);
    expect(config.AI_BUDGET_ALERT_PERCENT).toBe(80);
    expect(config.AI_DAILY_COST_CAP_USD).toBeUndefined();
    expect(config.PUBSUB_EMULATOR_HOST).toBeUndefined();
  });

  it('parses caps, the crawl allow-list and the undo window', () => {
    const config = parse({
      AI_DAILY_COST_CAP_USD: '2.5',
      AI_DAILY_TOKEN_CAP: '500000',
      AI_BUDGET_ALERT_PERCENT: '90',
      KB_CRAWL_ALLOWED_HOSTS: ' Docs.Example.com, status.example.com ,,',
      OUTBOUND_UNDO_SECONDS: '10',
      EMBEDDING_PROVIDER: 'vertex',
      DISCORD_WEBHOOK_URL: 'https://discord.example.com/api/webhooks/1/x',
    });
    expect(config.AI_DAILY_COST_CAP_USD).toBe(2.5);
    expect(config.AI_DAILY_TOKEN_CAP).toBe(500_000);
    expect(config.AI_BUDGET_ALERT_PERCENT).toBe(90);
    expect(config.KB_CRAWL_ALLOWED_HOSTS).toEqual(['docs.example.com', 'status.example.com']);
    expect(config.OUTBOUND_UNDO_SECONDS).toBe(10);
    expect(config.EMBEDDING_PROVIDER).toBe('vertex');
  });

  it.each([
    ['EMBEDDING_PROVIDER', 'openai'],
    ['AI_DAILY_COST_CAP_USD', '-1'],
    ['AI_DAILY_COST_CAP_USD', 'lots'],
    ['AI_DAILY_TOKEN_CAP', '1.5'],
    ['AI_BUDGET_ALERT_PERCENT', '0'],
    ['OUTBOUND_UNDO_SECONDS', '31'],
    ['KB_CRAWL_ALLOWED_HOSTS', 'http://docs.example.com/page'],
    ['DISCORD_WEBHOOK_URL', 'not a url'],
  ])('rejects %s=%s and names only the variable', (key, value) => {
    let error: unknown;
    try {
      parse({ [key]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain(key);
    expect(message).not.toContain(value);
  });
});

describe('.env.example', () => {
  const example = parseDotenv(
    readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
  );

  it('lists every Phase 1 variable, empty unless it has a harmless local default', () => {
    const defaults = new Map([
      ['GMAIL_MOCK_ENABLED', 'false'],
      ['OUTBOUND_UNDO_SECONDS', '5'],
      ['EMBEDDING_PROVIDER', 'mock'],
      ['AI_BUDGET_ALERT_PERCENT', '80'],
    ]);
    for (const key of Object.keys(phase1EnvShape)) {
      expect(Object.hasOwn(example, key), `${key} is missing from .env.example`).toBe(true);
      expect(example[key], key).toBe(defaults.get(key) ?? '');
    }
  });

  it('is a valid configuration that leaves every Phase 1 integration in mock mode', () => {
    const config = parseEnv(schema, example);
    expect(config.EMBEDDING_PROVIDER).toBe('mock');
    expect(config.KB_CRAWL_ALLOWED_HOSTS).toEqual([]);
    expect(config.DISCORD_WEBHOOK_URL).toBeUndefined();
    expect(config.GMAIL_PUSH_AUDIENCE).toBeUndefined();
  });
});
