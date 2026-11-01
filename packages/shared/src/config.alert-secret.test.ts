import { describe, expect, it } from 'vitest';

import { createEnvSchema, parseEnv } from './config.js';

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

describe('ALERT_WEBHOOK_SECRET', () => {
  it('needs 32 characters when it is set, and the message never echoes the value', () => {
    const short = 'abcdefghijklmnop';
    const ok = parseEnv(schema, { ...BASE, ALERT_WEBHOOK_SECRET: 'x'.repeat(32) });
    expect(ok.ALERT_WEBHOOK_SECRET).toBe('x'.repeat(32));
    expect(
      parseEnv(schema, { ...BASE, ALERT_WEBHOOK_SECRET: '' }).ALERT_WEBHOOK_SECRET,
    ).toBeUndefined();
    let message = '';
    try {
      parseEnv(schema, { ...BASE, ALERT_WEBHOOK_SECRET: short });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('ALERT_WEBHOOK_SECRET');
    expect(message).not.toContain(short);
  });
});
