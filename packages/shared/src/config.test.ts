import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigError, createEnvSchema, parseEnv } from './config.js';

const schema = createEnvSchema({ API_PORT: z.coerce.number().int().default(4000) });

const validEnv = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:4000',
  DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-value',
  JWT_SECRET: 'change-me',
  APP_ENCRYPTION_KEY: 'change-me-32-bytes-base64',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
};

const productionEnv = {
  ...validEnv,
  NODE_ENV: 'production',
  JWT_SECRET: 'a'.repeat(40),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_OIDC_CLIENT_ID: 'client-id.example',
  GOOGLE_OIDC_CLIENT_SECRET: 'client-secret-value',
  GOOGLE_ALLOWED_DOMAIN: 'example.com',
};

function issuesFor(env: Record<string, string | undefined>): Map<string, string> {
  try {
    parseEnv(schema, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      const byVariable = new Map<string, string>();
      for (const issue of error.issues) {
        const earlier = byVariable.get(issue.variable);
        byVariable.set(issue.variable, earlier ? `${earlier}; ${issue.message}` : issue.message);
      }
      return byVariable;
    }
    throw error;
  }
  return new Map();
}

describe('parseEnv', () => {
  it('accepts a complete development environment and applies defaults', () => {
    const config = parseEnv(schema, validEnv);
    expect(config.NODE_ENV).toBe('development');
    expect(config.SMTP_PORT).toBe(1025);
    expect(config.S3_REGION).toBe('us-east-1');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.API_PORT).toBe(4000);
  });

  it('treats an empty integration value as not set (mock mode)', () => {
    const config = parseEnv(schema, {
      ...validEnv,
      LINE_CHANNEL_ID: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: ' ',
    });
    expect(config.LINE_CHANNEL_ID).toBeUndefined();
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'S3_BUCKET',
    'JWT_SECRET',
    'APP_ENCRYPTION_KEY',
    'SMTP_HOST',
  ])('fails fast when %s is missing', (key) => {
    expect(issuesFor({ ...validEnv, [key]: undefined }).has(key)).toBe(true);
  });

  it('reports every problem at once, by variable name', () => {
    const issues = issuesFor({});
    expect([...issues.keys()]).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'SMTP_PORT']),
    );
  });

  it('rejects a malformed database url and port', () => {
    const issues = issuesFor({ ...validEnv, DATABASE_URL: 'mysql://x/y', SMTP_PORT: '99999' });
    expect(issues.has('DATABASE_URL')).toBe(true);
    expect(issues.has('SMTP_PORT')).toBe(true);
  });

  it('never prints the offending value', () => {
    const secretLooking = 'super-secret-credential-value';
    let message = '';
    try {
      parseEnv(schema, {
        ...validEnv,
        DATABASE_URL: secretLooking,
        NODE_ENV: 'production',
        JWT_SECRET: secretLooking,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(secretLooking);
  });
});

describe('production guards', () => {
  it('accepts a real production configuration', () => {
    expect(issuesFor(productionEnv).size).toBe(0);
  });

  it('rejects "change-me" placeholders in production', () => {
    const issues = issuesFor({
      ...productionEnv,
      JWT_SECRET: 'change-me-but-long-enough-to-pass-length',
    });
    expect(issues.get('JWT_SECRET')).toContain('placeholder');
    expect(issuesFor({ ...productionEnv, S3_SECRET_KEY: 'change-me' }).has('S3_SECRET_KEY')).toBe(
      true,
    );
  });

  it('allows the placeholders in development and test', () => {
    expect(issuesFor({ ...validEnv, NODE_ENV: 'test' }).size).toBe(0);
    expect(issuesFor(validEnv).size).toBe(0);
  });

  it('requires a long JWT secret and a 32-byte encryption key in production', () => {
    expect(issuesFor({ ...productionEnv, JWT_SECRET: 'short' }).has('JWT_SECRET')).toBe(true);
    expect(
      issuesFor({ ...productionEnv, APP_ENCRYPTION_KEY: 'not-base64!' }).has('APP_ENCRYPTION_KEY'),
    ).toBe(true);
    expect(
      issuesFor({ ...productionEnv, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }).has(
        'APP_ENCRYPTION_KEY',
      ),
    ).toBe(true);
  });
});

describe('mock sign-in is dev-only', () => {
  it.each(['GOOGLE_OIDC_CLIENT_ID', 'GOOGLE_OIDC_CLIENT_SECRET'])(
    'refuses to boot in production without %s (mock mode)',
    (key) => {
      const issues = issuesFor({ ...productionEnv, [key]: '' });
      expect(issues.get(key)).toContain('mock sign-in is not allowed');
    },
  );

  it('allows mock mode (empty credentials) outside production', () => {
    expect(issuesFor({ ...validEnv, GOOGLE_OIDC_CLIENT_ID: '' }).size).toBe(0);
    expect(issuesFor({ ...validEnv, NODE_ENV: 'test' }).size).toBe(0);
  });
});

describe('break-glass credentials', () => {
  it('needs the email and the password together', () => {
    expect(
      issuesFor({ ...validEnv, BREAK_GLASS_EMAIL: 'admin@example.com' }).has(
        'BREAK_GLASS_PASSWORD',
      ),
    ).toBe(true);
    expect(
      issuesFor({ ...validEnv, BREAK_GLASS_PASSWORD: 'a-long-enough-password' }).has(
        'BREAK_GLASS_EMAIL',
      ),
    ).toBe(true);
    expect(
      issuesFor({
        ...validEnv,
        BREAK_GLASS_EMAIL: 'admin@example.com',
        BREAK_GLASS_PASSWORD: 'a-long-enough-password',
      }).size,
    ).toBe(0);
  });

  it('rejects a short password without echoing it', () => {
    const issues = issuesFor({
      ...validEnv,
      BREAK_GLASS_EMAIL: 'admin@example.com',
      BREAK_GLASS_PASSWORD: 'short',
    });
    expect(issues.get('BREAK_GLASS_PASSWORD')).toContain('at least 12');
    expect(issues.get('BREAK_GLASS_PASSWORD')).not.toContain('short');
  });

  it('refuses a placeholder password in production', () => {
    const issues = issuesFor({
      ...productionEnv,
      BREAK_GLASS_EMAIL: 'admin@example.com',
      BREAK_GLASS_PASSWORD: 'change-me-change-me',
    });
    expect(issues.get('BREAK_GLASS_PASSWORD')).toContain('placeholder');
  });
});

describe('Google OIDC domain restriction', () => {
  it('requires GOOGLE_ALLOWED_DOMAIN once OIDC credentials are set', () => {
    const withClient = {
      ...validEnv,
      GOOGLE_OIDC_CLIENT_ID: 'client-id',
      GOOGLE_OIDC_CLIENT_SECRET: 'x',
    };
    expect(issuesFor(withClient).has('GOOGLE_ALLOWED_DOMAIN')).toBe(true);
    expect(issuesFor({ ...withClient, GOOGLE_ALLOWED_DOMAIN: 'example.com' }).size).toBe(0);
  });
});

describe('.env.example', () => {
  const example = parseDotenv(
    readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
  );

  it('is a valid development configuration with the documented defaults', () => {
    const config = parseEnv(schema, example);
    expect(config.GOOGLE_ALLOWED_DOMAIN).toBe('example.com');
    expect(config.S3_REGION).toBe('us-east-1');
    expect(config.AI_PROVIDER).toBe('mock');
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('has no trailing comment glued to a value', () => {
    for (const [key, value] of Object.entries(example)) {
      expect(value, key).not.toMatch(/\s#/);
    }
  });

  it('is refused as-is in production because of its change-me placeholders', () => {
    const issues = issuesFor({ ...example, NODE_ENV: 'production' });
    expect(issues.get('JWT_SECRET')).toContain('placeholder');
    expect(issues.get('APP_ENCRYPTION_KEY')).toContain('placeholder');
  });
});
