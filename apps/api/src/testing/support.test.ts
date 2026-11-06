import { afterEach, expect, it, vi } from 'vitest';

import { testEnv } from './support.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('points every test transport at the explicitly selected disposable service', () => {
  vi.stubEnv('TEST_DATABASE_URL', 'postgres://test:test@127.0.0.1:45802/test');
  vi.stubEnv('TEST_REDIS_URL', 'redis://127.0.0.1:46802');
  vi.stubEnv('TEST_S3_ENDPOINT', 'http://127.0.0.1:49802');
  vi.stubEnv('TEST_SMTP_PORT', '41802');
  expect(testEnv()).toMatchObject({
    DATABASE_URL: 'postgres://test:test@127.0.0.1:45802/test',
    REDIS_URL: 'redis://127.0.0.1:46802',
    S3_ENDPOINT: 'http://127.0.0.1:49802',
    SMTP_PORT: '41802',
  });
});
