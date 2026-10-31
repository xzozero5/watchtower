import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../bootstrap.js';
import { createLogger } from '../logging/logger.js';
import { listenOnFreePort, testConfig } from '../testing/support.js';

// The real AppModule against the Postgres and Redis from docker compose
// (`docker compose up -d --wait postgres redis`).

async function startApp(overrides: Record<string, string | undefined> = {}) {
  const config = testConfig(overrides);
  const app = await createApp(config, createLogger(config));
  return { app, base: await listenOnFreePort(app) };
}

describe('GET /health and /health/ready against real Postgres and Redis', () => {
  let app: NestExpressApplication;
  let base = '';

  beforeAll(async () => {
    ({ app, base } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers 200 with service and version', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'watchtower-api',
      version: '0.0.0',
    });
  });

  it('GET /health/ready reports Postgres and Redis up', async () => {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('serves OpenAPI at /docs and /docs-json', async () => {
    expect((await fetch(`${base}/docs`)).status).toBe(200);
    const document = (await (await fetch(`${base}/docs-json`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health', '/health/ready']),
    );
  });

  it('serves Prometheus metrics at /metrics', async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('http_server_request_duration_bucket');
  });
});

describe('readiness when a dependency is unreachable', () => {
  it('returns 503 naming Redis (and not Postgres) when Redis is down', async () => {
    // Port 1 is never listening: connection refused immediately.
    const { app, base } = await startApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const response = await fetch(`${base}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        status: 'unavailable',
        checks: { database: { status: 'up' }, redis: { status: 'down' } },
      });
      // Liveness stays 200: a dependency outage must not get the container restarted.
      expect((await fetch(`${base}/health`)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('returns 503 naming Postgres when Postgres is down', async () => {
    const { app, base } = await startApp({
      DATABASE_URL: 'postgres://watchtower:watchtower@127.0.0.1:1/watchtower',
    });
    try {
      const response = await fetch(`${base}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        checks: { database: { status: 'down' }, redis: { status: 'up' } },
      });
    } finally {
      await app.close();
    }
  });
});
