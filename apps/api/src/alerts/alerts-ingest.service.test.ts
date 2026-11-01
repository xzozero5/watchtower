import { alerts } from '@watchtower/connectors';
import type { CredentialStore, Database } from '@watchtower/db';
import { DomainError, type Domain } from '@watchtower/domain';
import { describe, expect, it } from 'vitest';

import type { RateLimiter } from '../auth/rate-limiter.js';
import type { ApiConfig } from '../config/config.js';
import type { AppLogger } from '../logging/logger.js';
import { AlertIngestService } from './alerts-ingest.service.js';

// The service with fakes for everything outside it: what it does when the domain refuses a delivery for
// good, and with a signing secret that is too short.

const SECRET = 's'.repeat(40);
const logLines: string[] = [];
const logger = {
  warn: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
  error: (...args: unknown[]) => logLines.push(JSON.stringify(args)),
  info: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger;

const limiter = {
  blocked: () => Promise.resolve({ blocked: false, retryAfterSeconds: 0 }),
  hit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 1, count: 1 }),
} as unknown as RateLimiter;

function service(options: { ingest: () => never | Promise<never>; secret?: string }) {
  const database = {
    db: { transaction: (work: (tx: unknown) => unknown) => work({}) },
  } as unknown as Database;
  const domain = {
    context: () => ({}),
    alerts: { ingest: options.ingest },
  } as unknown as Domain;
  const credentials = {
    resolve: () => Promise.resolve({ webhookSecret: { value: options.secret ?? SECRET } }),
  } as unknown as CredentialStore;
  const config = { ALERT_INGEST_RATE_PER_MINUTE: 600 } as unknown as ApiConfig;
  return new AlertIngestService(database, domain, null, credentials, limiter, config, logger);
}

const body = JSON.stringify({
  version: '4',
  alerts: [{ status: 'firing', labels: { alertname: 'A' }, startsAt: '2026-11-02T03:00:00Z' }],
});
const header = (secret = SECRET) =>
  alerts.signAlertWebhook({
    rawBody: body,
    secret,
    timestampSeconds: Math.floor(Date.now() / 1000),
  });

describe('a delivery the domain refuses for good', () => {
  it('is acknowledged as ignored and logged by code only, so the sender stops retrying', async () => {
    const svc = service({
      ingest: () => {
        throw new DomainError('bad_request', 'The alert is not a valid normalized alert');
      },
    });
    const result = await svc.acceptWebhook({
      rawBody: Buffer.from(body),
      signature: header(),
      ip: '198.51.100.1',
    });
    expect(result).toEqual({ accepted: 0, duplicates: 0, ignored: 1 });
    expect(logLines.join('\n')).toContain('refuses as invalid');
    expect(logLines.join('\n')).not.toContain('"A"');
  });

  it('but any other failure is still raised, so a database that is down is retried', async () => {
    const svc = service({
      ingest: () => {
        throw new Error('connection refused');
      },
    });
    await expect(
      svc.acceptWebhook({ rawBody: Buffer.from(body), signature: header(), ip: '198.51.100.1' }),
    ).rejects.toThrow('connection refused');
  });
});

describe('a signing secret that is too short', () => {
  it('is treated as no secret: even a correct signature gets 401', async () => {
    const short = 'x'.repeat(16);
    const svc = service({ ingest: () => never(), secret: short });
    await expect(
      svc.acceptWebhook({
        rawBody: Buffer.from(body),
        signature: header(short),
        ip: '198.51.100.1',
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
});

function never(): never {
  throw new Error('must not be reached');
}
