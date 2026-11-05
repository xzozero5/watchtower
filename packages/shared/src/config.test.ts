import { readFileSync } from 'node:fs';
import { parseEnv as parseDotenv } from 'node:util';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CLAUDE_CLI_REMOTE_WARNING,
  ConfigError,
  claudeCliRemoteWarning,
  createEnvSchema,
  isLoopbackUrl,
  parseEnv,
} from './config.js';

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

describe('dev login needs an explicit opt-in (C-1)', () => {
  it('is off unless DEV_LOGIN_ENABLED is set to true', () => {
    expect(parseEnv(schema, validEnv).DEV_LOGIN_ENABLED).toBe(false);
    expect(parseEnv(schema, { ...validEnv, DEV_LOGIN_ENABLED: '' }).DEV_LOGIN_ENABLED).toBe(false);
    expect(parseEnv(schema, { ...validEnv, DEV_LOGIN_ENABLED: 'true' }).DEV_LOGIN_ENABLED).toBe(
      true,
    );
  });

  it('refuses to boot in production even with credentials set', () => {
    const issues = issuesFor({ ...productionEnv, DEV_LOGIN_ENABLED: 'true' });
    expect(issues.get('DEV_LOGIN_ENABLED')).toContain('production');
  });

  it('refuses to boot when Google sign-in is configured (live mode)', () => {
    const issues = issuesFor({
      ...validEnv,
      DEV_LOGIN_ENABLED: 'true',
      GOOGLE_OIDC_CLIENT_ID: 'id.example',
      GOOGLE_OIDC_CLIENT_SECRET: 'client-value',
      GOOGLE_ALLOWED_DOMAIN: 'example.com',
    });
    expect(issues.get('DEV_LOGIN_ENABLED')).toContain('mock mode');
  });

  it('is accepted in mock mode outside production', () => {
    expect(issuesFor({ ...validEnv, DEV_LOGIN_ENABLED: 'true' }).size).toBe(0);
  });
});

describe('the fake LINE Login needs an explicit opt-in (C-2)', () => {
  it('is off unless LINE_LOGIN_FAKE_ENABLED is set to true', () => {
    expect(parseEnv(schema, validEnv).LINE_LOGIN_FAKE_ENABLED).toBe(false);
    expect(
      parseEnv(schema, { ...validEnv, LINE_LOGIN_FAKE_ENABLED: '' }).LINE_LOGIN_FAKE_ENABLED,
    ).toBe(false);
    expect(
      parseEnv(schema, { ...validEnv, LINE_LOGIN_FAKE_ENABLED: 'true' }).LINE_LOGIN_FAKE_ENABLED,
    ).toBe(true);
  });

  it('is accepted on a loopback APP_URL outside production', () => {
    expect(issuesFor({ ...validEnv, LINE_LOGIN_FAKE_ENABLED: 'true' }).size).toBe(0);
  });

  it('refuses to boot in production', () => {
    const issues = issuesFor({ ...productionEnv, LINE_LOGIN_FAKE_ENABLED: 'true' });
    expect(issues.get('LINE_LOGIN_FAKE_ENABLED')).toContain('production');
  });

  it('refuses to boot when LINE Login credentials are set', () => {
    const issues = issuesFor({
      ...validEnv,
      LINE_LOGIN_FAKE_ENABLED: 'true',
      LINE_LOGIN_CHANNEL_ID: '1234567890',
    });
    expect(issues.get('LINE_LOGIN_FAKE_ENABLED')).toContain('credentials');
  });

  it('refuses to boot on an APP_URL that is not loopback', () => {
    const issues = issuesFor({
      ...validEnv,
      APP_URL: 'https://desk.example.com',
      JWT_SECRET: 'x'.repeat(48),
      APP_ENCRYPTION_KEY: 'y'.repeat(48),
      LINE_LOGIN_FAKE_ENABLED: 'true',
    });
    expect(issues.get('LINE_LOGIN_FAKE_ENABLED')).toContain('loopback');
  });
});

describe('weak secrets are refused off the local machine (C-1)', () => {
  const remote = { ...validEnv, APP_URL: 'https://staging.example.com' };

  it.each(['JWT_SECRET', 'APP_ENCRYPTION_KEY'])(
    'refuses a placeholder %s when APP_URL is not loopback',
    (key) => {
      expect(
        issuesFor({ ...remote, [key]: 'change-me-but-long-enough-to-pass-32-bytes' }).get(key),
      ).toContain('placeholder');
    },
  );

  it.each(['JWT_SECRET', 'APP_ENCRYPTION_KEY'])('refuses a %s shorter than 32 bytes', (key) => {
    expect(issuesFor({ ...remote, [key]: 'x'.repeat(31) }).has(key)).toBe(true);
  });

  it('accepts strong values on a remote URL', () => {
    expect(
      issuesFor({
        ...remote,
        JWT_SECRET: 'q'.repeat(40),
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      }).size,
    ).toBe(0);
  });

  it('allows the example values only on a loopback APP_URL outside production', () => {
    expect(issuesFor(validEnv).size).toBe(0);
    expect(issuesFor({ ...validEnv, APP_URL: 'http://127.0.0.1:3000' }).size).toBe(0);
    expect(issuesFor({ ...validEnv, APP_URL: 'http://[::1]:3000' }).size).toBe(0);
    expect(issuesFor({ ...validEnv, APP_URL: 'http://192.168.1.20:3000' }).has('JWT_SECRET')).toBe(
      true,
    );
    expect(
      issuesFor({ ...validEnv, APP_URL: 'http://localhost.evil.example' }).has('JWT_SECRET'),
    ).toBe(true);
  });

  it('never prints the weak value', () => {
    let message = '';
    try {
      parseEnv(schema, { ...remote, JWT_SECRET: 'tiny-value-xyz' });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('JWT_SECRET');
    expect(message).not.toContain('tiny-value-xyz');
  });
});

describe('isLoopbackUrl', () => {
  it('recognises only addresses that stay on this machine', () => {
    for (const url of [
      'http://localhost:3000',
      'http://127.0.0.1',
      'http://127.1.2.3:80',
      'http://[::1]:4000',
      'http://app.localhost',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
    for (const url of [
      'https://example.com',
      'http://10.0.0.1',
      'http://localhost.example.com',
      'not a url',
      '',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
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

describe('dev login on a reachable host (C-16)', () => {
  it('refuses DEV_LOGIN_ENABLED=true when APP_URL is not loopback', () => {
    const issues = issuesFor({
      ...validEnv,
      DEV_LOGIN_ENABLED: 'true',
      APP_URL: 'https://support.example.com',
    });
    expect(issues.get('DEV_LOGIN_ENABLED')).toContain('loopback');
  });

  it('allows it on a loopback APP_URL', () => {
    expect(
      issuesFor({ ...validEnv, DEV_LOGIN_ENABLED: 'true', APP_URL: 'http://localhost:3000' }).has(
        'DEV_LOGIN_ENABLED',
      ),
    ).toBe(false);
  });
});

describe('the in-memory Gmail needs an explicit opt-in (T-102 N-1)', () => {
  it.each([
    'GMAIL_SERVICE_ACCOUNT_JSON_PATH',
    'GMAIL_IMPERSONATE_USER',
    'GMAIL_OAUTH_CLIENT_ID',
    'GMAIL_OAUTH_CLIENT_SECRET',
    'GMAIL_OAUTH_REFRESH_TOKEN',
    'GMAIL_OAUTH_MAILBOX',
  ])('refuses the flag while %s is set', (name) => {
    expect(() =>
      parseEnv(schema, { ...validEnv, GMAIL_MOCK_ENABLED: 'true', [name]: 'x' }),
    ).toThrow(/GMAIL_MOCK_ENABLED/);
  });

  it('is off unless GMAIL_MOCK_ENABLED is true, including when NODE_ENV is development', () => {
    expect(parseEnv(schema, validEnv).GMAIL_MOCK_ENABLED).toBe(false);
    expect(parseEnv(schema, { ...validEnv, NODE_ENV: 'development' }).GMAIL_MOCK_ENABLED).toBe(
      false,
    );
    expect(parseEnv(schema, { ...validEnv, GMAIL_MOCK_ENABLED: '' }).GMAIL_MOCK_ENABLED).toBe(
      false,
    );
    expect(parseEnv(schema, { ...validEnv, GMAIL_MOCK_ENABLED: 'true' }).GMAIL_MOCK_ENABLED).toBe(
      true,
    );
  });

  it('refuses to boot in production', () => {
    expect(
      issuesFor({ ...productionEnv, GMAIL_MOCK_ENABLED: 'true' }).get('GMAIL_MOCK_ENABLED'),
    ).toContain('production');
  });

  it('refuses to boot when APP_URL is not loopback, even under NODE_ENV=development (compose default)', () => {
    const issues = issuesFor({
      ...validEnv,
      NODE_ENV: 'development',
      GMAIL_MOCK_ENABLED: 'true',
      APP_URL: 'https://support.example.com',
    });
    expect(issues.get('GMAIL_MOCK_ENABLED')).toContain('loopback');
  });

  it('is accepted on a loopback APP_URL', () => {
    expect(
      issuesFor({ ...validEnv, GMAIL_MOCK_ENABLED: 'true', APP_URL: 'http://localhost:3000' }).has(
        'GMAIL_MOCK_ENABLED',
      ),
    ).toBe(false);
  });
});

describe('AI_PROVIDER=claude-cli (ADR-017, dev/POC only)', () => {
  it('is accepted on a loopback APP_URL outside production', () => {
    expect(issuesFor({ ...validEnv, AI_PROVIDER: 'claude-cli' }).has('AI_PROVIDER')).toBe(false);
  });

  it('refuses to boot in production', () => {
    expect(issuesFor({ ...productionEnv, AI_PROVIDER: 'claude-cli' }).get('AI_PROVIDER')).toContain(
      'production',
    );
  });

  it('refuses to boot when APP_URL is not loopback, even under NODE_ENV=development', () => {
    const issues = issuesFor({
      ...validEnv,
      AI_PROVIDER: 'claude-cli',
      APP_URL: 'https://support.example.com',
    });
    expect(issues.get('AI_PROVIDER')).toContain('loopback');
  });

  it('CLAUDE_CLI_ALLOW_REMOTE=true accepts production and a non-loopback APP_URL (ADR-021)', () => {
    expect(
      issuesFor({
        ...productionEnv,
        AI_PROVIDER: 'claude-cli',
        CLAUDE_CLI_ALLOW_REMOTE: 'true',
      }).has('AI_PROVIDER'),
    ).toBe(false);
    expect(
      issuesFor({
        ...validEnv,
        AI_PROVIDER: 'claude-cli',
        APP_URL: 'https://support.example.com',
        CLAUDE_CLI_ALLOW_REMOTE: 'true',
      }).has('AI_PROVIDER'),
    ).toBe(false);
  });

  it('CLAUDE_CLI_ALLOW_REMOTE=false (or empty) keeps the refusal', () => {
    for (const value of ['false', '']) {
      expect(
        issuesFor({
          ...productionEnv,
          AI_PROVIDER: 'claude-cli',
          CLAUDE_CLI_ALLOW_REMOTE: value,
        }).get('AI_PROVIDER'),
      ).toContain('production');
    }
  });

  it('leaves the other providers alone in production', () => {
    expect(issuesFor({ ...productionEnv, AI_PROVIDER: 'anthropic' }).has('AI_PROVIDER')).toBe(
      false,
    );
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

describe('GOOGLE_ALLOWED_EMAILS', () => {
  it('parses a list, trimmed and lower-cased, and is empty when unset', () => {
    expect(parseEnv(schema, validEnv).GOOGLE_ALLOWED_EMAILS).toEqual([]);
    const config = parseEnv(schema, {
      ...validEnv,
      GOOGLE_ALLOWED_EMAILS: ' A@Gmail.com , b@gmail.com ',
    });
    expect(config.GOOGLE_ALLOWED_EMAILS).toEqual(['a@gmail.com', 'b@gmail.com']);
  });

  it('rejects wildcards and malformed addresses', () => {
    for (const bad of ['*@gmail.com', 'a*@gmail.com', 'nope']) {
      // The issue is reported per entry (GOOGLE_ALLOWED_EMAILS.0) and never echoes the value.
      const names = [...issuesFor({ ...validEnv, GOOGLE_ALLOWED_EMAILS: bad }).keys()];
      expect(
        names.some((name) => name.startsWith('GOOGLE_ALLOWED_EMAILS')),
        bad,
      ).toBe(true);
    }
  });

  it('is refused in production and fine elsewhere', () => {
    const set = { GOOGLE_ALLOWED_EMAILS: 'a@gmail.com' };
    expect(issuesFor({ ...productionEnv, ...set }).has('GOOGLE_ALLOWED_EMAILS')).toBe(true);
    expect(issuesFor({ ...productionEnv, GOOGLE_ALLOWED_EMAILS: '' }).size).toBe(0);
    expect(issuesFor({ ...validEnv, ...set }).size).toBe(0);
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

describe('PRODUCT_DB_URL (T-203c)', () => {
  const mock = 'postgres://product_mock_ro:product_mock_ro@localhost:5432/product_mock';
  const real = `postgres://reader:${'k'.repeat(24)}@db.internal:5432/product`;
  const hosted = {
    ...productionEnv,
    NODE_ENV: 'development',
    APP_URL: 'https://ops.example.com',
  };

  it('lets the local mock login through on a local run and nowhere else', () => {
    expect(issuesFor({ ...validEnv, PRODUCT_DB_URL: mock }).has('PRODUCT_DB_URL')).toBe(false);
    expect(issuesFor({ ...hosted, PRODUCT_DB_URL: mock }).get('PRODUCT_DB_URL')).toContain(
      'real password',
    );
    expect(issuesFor({ ...productionEnv, PRODUCT_DB_URL: mock }).get('PRODUCT_DB_URL')).toContain(
      'real password',
    );
    const noPassword = 'postgres://reader@db.internal/product';
    expect(issuesFor({ ...productionEnv, PRODUCT_DB_URL: noPassword }).has('PRODUCT_DB_URL')).toBe(
      true,
    );
    expect(issuesFor({ ...productionEnv, PRODUCT_DB_URL: real }).has('PRODUCT_DB_URL')).toBe(false);
    expect(issuesFor({ ...hosted, PRODUCT_DB_URL: real }).has('PRODUCT_DB_URL')).toBe(false);
  });

  it('never echoes the password', () => {
    const message =
      issuesFor({ ...productionEnv, PRODUCT_DB_URL: mock }).get('PRODUCT_DB_URL') ?? '';
    expect(message).not.toContain('product_mock_ro');
  });
});

describe('claudeCliRemoteWarning (ADR-021)', () => {
  it('warns only for claude-cli with the opt-in on', () => {
    expect(
      claudeCliRemoteWarning({ AI_PROVIDER: 'claude-cli', CLAUDE_CLI_ALLOW_REMOTE: true }),
    ).toBe(CLAUDE_CLI_REMOTE_WARNING);
    expect(
      claudeCliRemoteWarning({ AI_PROVIDER: 'claude-cli', CLAUDE_CLI_ALLOW_REMOTE: false }),
    ).toBeUndefined();
    expect(
      claudeCliRemoteWarning({ AI_PROVIDER: 'mock', CLAUDE_CLI_ALLOW_REMOTE: true }),
    ).toBeUndefined();
  });
});

describe('AI bridge config (ADR-031)', () => {
  it('accepts ai-cli locally and applies the production and remote guard to both CLI kinds', () => {
    for (const provider of ['ai-cli', 'claude-cli']) {
      expect(issuesFor({ ...validEnv, AI_PROVIDER: provider }).has('AI_PROVIDER')).toBe(false);
      expect(issuesFor({ ...productionEnv, AI_PROVIDER: provider }).get('AI_PROVIDER')).toContain(
        'production',
      );
      expect(
        issuesFor({ ...productionEnv, AI_PROVIDER: provider, AI_BRIDGE_ALLOW_REMOTE: 'true' }).has(
          'AI_PROVIDER',
        ),
      ).toBe(false);
      expect(
        issuesFor({
          ...productionEnv,
          AI_PROVIDER: provider,
          CLAUDE_CLI_ALLOW_REMOTE: 'true',
          AI_BRIDGE_ALLOW_REMOTE: 'false',
        }).get('AI_PROVIDER'),
      ).toContain('production');
      expect(
        issuesFor({ ...productionEnv, AI_PROVIDER: provider, CLAUDE_CLI_ALLOW_REMOTE: 'true' }).has(
          'AI_PROVIDER',
        ),
      ).toBe(false);
    }
  });

  it('parses canonical settings without exposing their values in warnings', () => {
    const config = parseEnv(schema, {
      ...validEnv,
      AI_PROVIDER: 'ai-cli',
      AI_BRIDGE_URL: 'http://ai-bridge:4317',
      AI_BRIDGE_TOKEN: 'test-token',
      AI_BRIDGE_ALLOW_REMOTE: 'true',
    });
    expect(config.AI_BRIDGE_URL).toBe('http://ai-bridge:4317');
    expect(config.AI_BRIDGE_TOKEN).toBe('test-token');
    expect(claudeCliRemoteWarning(config)).toBe('ai-cli remote opt-in enabled (ADR-031)');
    expect(claudeCliRemoteWarning({ ...config, AI_BRIDGE_ALLOW_REMOTE: false })).toBeUndefined();
  });
});
