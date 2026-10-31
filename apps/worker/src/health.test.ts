import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createHealthServer, type DependencyCheck } from './health.js';
import { createLogger } from './logger.js';
import { testConfig } from './testing/support.js';

let server: Server | undefined;

async function start(checks: Record<string, DependencyCheck>, timeoutMs?: number) {
  server = createHealthServer({
    service: 'watchtower-worker',
    version: '9.9.9',
    checks,
    logger: createLogger(testConfig()),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) {
    await new Promise<void>((resolve) => {
      running.close(() => {
        resolve();
      });
      running.closeAllConnections();
    });
  }
});

describe('worker health server', () => {
  it('GET /health is liveness and ignores failing dependencies', async () => {
    const base = await start({ redis: () => Promise.reject(new Error('down')) });
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      service: 'watchtower-worker',
      version: '9.9.9',
    });
  });

  it('GET /health/ready is 200 when every check passes', async () => {
    const base = await start({ database: () => Promise.resolve(), redis: () => Promise.resolve() });
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('GET /health/ready is 503 and hides the error when a check fails', async () => {
    const base = await start({
      database: () => Promise.resolve(),
      redis: () => Promise.reject(new Error('secret-host:6379 refused')),
    });
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'up' }, redis: { status: 'down' } },
    });
    expect(text).not.toContain('secret-host');
  });

  it('treats a check that never answers as down', async () => {
    const base = await start({ redis: () => new Promise<void>(() => undefined) }, 50);
    expect((await fetch(`${base}/health/ready`)).status).toBe(503);
  });

  it('answers 404 for unknown paths and 405 for non-GET', async () => {
    const base = await start({});
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(405);
  });
});
