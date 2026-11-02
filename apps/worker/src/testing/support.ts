import { QUEUE_NAMES, splitEmailSecrets, type EmailJob } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey, outboxAad, sealFields } from '@watchtower/shared/secret-box';

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
    // TEST_* overrides let the suite run beside a dev stack whose services use other credentials.
    S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000',
    S3_BUCKET: 'watchtower',
    S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY ?? 'minio',
    S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY ?? 'minio12345',
    JWT_SECRET: 'change-me',
    APP_ENCRYPTION_KEY: 'change-me-32-bytes-base64',
    SMTP_HOST: 'localhost',
    SMTP_PORT: process.env.TEST_SMTP_PORT ?? '1025',
    WORKER_PORT: '4100',
    // The tests run on the in-memory Gmail (T-102); it is an explicit opt-in.
    GMAIL_MOCK_ENABLED: 'true',
    ...overrides,
  };
}

export function testConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
): WorkerConfig {
  return loadConfig(testEnv(overrides));
}

/** The outbox subkey of a test config, the same one the worker opens links with. */
export function testSealKey(config: Pick<WorkerConfig, 'APP_ENCRYPTION_KEY'>): Buffer {
  return deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret);
}

/**
 * What the api writes to `outbox.payload` for an email: the clear fields, and the links sealed
 * under the outbox subkey and bound to `(email queue, jobId)`.
 */
export function sealedEmailPayload(
  job: EmailJob,
  jobId: string,
  key: Buffer,
): Record<string, unknown> {
  const { clear, secret } = splitEmailSecrets(job);
  return { ...clear, secret: sealFields(key, secret, outboxAad(QUEUE_NAMES.email, jobId)) };
}
