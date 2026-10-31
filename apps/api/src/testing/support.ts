import type { INestApplication } from '@nestjs/common';

import { loadConfig, type ApiConfig } from '../config/config.js';

/** A complete, valid environment pointing at the compose services on localhost. */
export function testEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  // Dev login is an explicit opt-in; tests sign in with it, so it is on unless the test makes
  // Google live (the config guard refuses both together).
  const live =
    Boolean(overrides.GOOGLE_OIDC_CLIENT_ID) || Boolean(overrides.GOOGLE_OIDC_CLIENT_SECRET);
  return {
    DEV_LOGIN_ENABLED: live ? 'false' : 'true',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    APP_URL: 'http://localhost:3000',
    API_URL: 'http://localhost:4000',
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? 'postgres://watchtower:watchtower@localhost:5432/watchtower',
    REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'watchtower',
    S3_ACCESS_KEY: 'minio',
    S3_SECRET_KEY: 'minio12345',
    JWT_SECRET: 'change-me',
    APP_ENCRYPTION_KEY: 'change-me-32-bytes-base64',
    SMTP_HOST: 'localhost',
    SMTP_PORT: '1025',
    ...overrides,
  };
}

export function testConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
): ApiConfig {
  return loadConfig(testEnv(overrides));
}

/** Listens on an ephemeral loopback port and returns the base url. */
export async function listenOnFreePort(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return url.replace('[::1]', '127.0.0.1');
}

/** Collects pino output so a test can assert on what was (and was not) logged. */
export function captureLogs(): {
  readonly destination: { write(chunk: string): void };
  lines(): Record<string, unknown>[];
  raw(): string;
} {
  const chunks: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => chunks.join(''),
  };
}
