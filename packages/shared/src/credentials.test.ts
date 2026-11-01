import { describe, expect, it } from 'vitest';

import { baseEnvShape, phase1EnvShape, parseEnv, createEnvSchema, ConfigError } from './config.js';
import {
  CREDENTIAL_ENV_VARS,
  CREDENTIAL_VALUE_MAX_LENGTH,
  INTEGRATION_CATALOG,
  INTEGRATION_KEYS,
  integrationFields,
  pickCredentialEnv,
  putCredentialsSchema,
  testConnectionSchema,
} from './features/credentials.js';

describe('INTEGRATION_CATALOG', () => {
  it('names only environment variables the configuration knows', () => {
    const known = new Set([...Object.keys(baseEnvShape), ...Object.keys(phase1EnvShape)]);
    for (const name of CREDENTIAL_ENV_VARS) {
      expect(known.has(name), `${name} is not in the shared env schema`).toBe(true);
    }
  });

  it('uses every environment variable once and valid field names', () => {
    expect(new Set(CREDENTIAL_ENV_VARS).size).toBe(CREDENTIAL_ENV_VARS.length);
    for (const key of INTEGRATION_KEYS) {
      expect(key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
      for (const field of Object.keys(integrationFields(key))) {
        // The same pattern as the check constraint in migration 0010.
        expect(field).toMatch(/^[A-Za-z][A-Za-z0-9]{0,59}$/);
      }
    }
    expect(INTEGRATION_CATALOG.line.fields.channelSecret.secret).toBe(true);
  });
});

describe('pickCredentialEnv', () => {
  it('keeps catalog variables with a value and drops empty ones and everything else', () => {
    const picked = pickCredentialEnv({
      LINE_CHANNEL_SECRET: 's',
      LINE_CHANNEL_ID: '  ',
      DATABASE_URL: 'postgres://x',
      ANTHROPIC_API_KEY: 12,
    });
    expect(picked.LINE_CHANNEL_SECRET).toBe('s');
    expect(picked.LINE_CHANNEL_ID).toBeUndefined();
    expect(picked.ANTHROPIC_API_KEY).toBeUndefined();
    expect('DATABASE_URL' in picked).toBe(false);
  });
});

describe('request schemas', () => {
  it('trims values and refuses empty, oversized and no fields at all', () => {
    expect(putCredentialsSchema.parse({ fields: { channelSecret: '  abc\n' } })).toEqual({
      fields: { channelSecret: 'abc' },
    });
    expect(putCredentialsSchema.safeParse({ fields: {} }).success).toBe(false);
    expect(putCredentialsSchema.safeParse({ fields: { channelSecret: '   ' } }).success).toBe(
      false,
    );
    expect(
      putCredentialsSchema.safeParse({
        fields: { channelSecret: 'x'.repeat(CREDENTIAL_VALUE_MAX_LENGTH + 1) },
      }).success,
    ).toBe(false);
    expect(testConnectionSchema.parse({})).toEqual({});
  });
});

describe('encryption key rotation settings', () => {
  const schema = createEnvSchema({});
  const base: Record<string, string> = {
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:4000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/d',
    REDIS_URL: 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY: 'a',
    S3_SECRET_KEY: 's',
    JWT_SECRET: 'change-me',
    APP_ENCRYPTION_KEY: 'change-me-32-bytes-base64',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
  };

  it('defaults to version 1 with no previous key', () => {
    const config = parseEnv(schema, base);
    expect(config.APP_ENCRYPTION_KEY_VERSION).toBe(1);
    expect(config.APP_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
    expect(config.APP_ENCRYPTION_KEY_PREVIOUS_VERSION).toBeUndefined();
  });

  it('accepts a previous key with a lower version', () => {
    const config = parseEnv(schema, {
      ...base,
      APP_ENCRYPTION_KEY_VERSION: '2',
      APP_ENCRYPTION_KEY_PREVIOUS: 'old-key',
      APP_ENCRYPTION_KEY_PREVIOUS_VERSION: '1',
    });
    expect(config.APP_ENCRYPTION_KEY_VERSION).toBe(2);
    expect(config.APP_ENCRYPTION_KEY_PREVIOUS_VERSION).toBe(1);
  });

  it.each([
    [
      'only the key',
      { APP_ENCRYPTION_KEY_PREVIOUS: 'old-key' },
      'APP_ENCRYPTION_KEY_PREVIOUS_VERSION',
    ],
    [
      'only the version',
      { APP_ENCRYPTION_KEY_PREVIOUS_VERSION: '1' },
      'APP_ENCRYPTION_KEY_PREVIOUS',
    ],
    [
      'a version that is not lower',
      {
        APP_ENCRYPTION_KEY_PREVIOUS: 'old-key',
        APP_ENCRYPTION_KEY_PREVIOUS_VERSION: '1',
      },
      'APP_ENCRYPTION_KEY_PREVIOUS_VERSION',
    ],
  ])('refuses %s, naming the variable and not the value', (_label, extra, variable) => {
    let error: unknown;
    try {
      parseEnv(schema, { ...base, ...extra });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(variable);
    expect((error as ConfigError).message).not.toContain('old-key');
  });
});
