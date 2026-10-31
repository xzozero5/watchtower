import { loadConfig, type WorkerConfig } from '../config.js';

/** A complete, valid environment pointing at the compose services on localhost. */
export function testEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
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
    WORKER_PORT: '4100',
    ...overrides,
  };
}

export function testConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
): WorkerConfig {
  return loadConfig(testEnv(overrides));
}
