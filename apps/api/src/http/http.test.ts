import { Body, Controller, Get, Post, Query, type INestApplication } from '@nestjs/common';
import { ApiCreatedResponse } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { configureApp } from '../bootstrap.js';
import { AppConfigModule } from '../config/config.module.js';
import { DATABASE } from '../database/database.module.js';
import { HealthController } from '../health/health.controller.js';
import { HealthService } from '../health/health.service.js';
import { createLogger } from '../logging/logger.js';
import { LoggingModule } from '../logging/logging.module.js';
import { REDIS } from '../redis/redis.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { captureLogs, listenOnFreePort, testConfig } from '../testing/support.js';

const createThingSchema = z.object({ name: z.string().min(1), size: z.number().int().positive() });
const thingSchema = createThingSchema.extend({ id: z.string() });
const searchSchema = z.object({ q: z.string().min(2) });

@Controller('things')
class ThingsController {
  @Post()
  @ApiCreatedResponse({ standardSchema: thingSchema })
  create(@Body({ schema: createThingSchema }) body: z.infer<typeof createThingSchema>) {
    return { id: 'thing-1', ...body };
  }

  @Get()
  search(@Query({ schema: searchSchema }) query: z.infer<typeof searchSchema>) {
    return { q: query.q };
  }

  @Get('boom')
  boom(): never {
    throw new Error('unexpected failure');
  }
}

let databaseUp = true;
let redisUp = true;
const fakeDatabase = {
  ping: () => (databaseUp ? Promise.resolve() : Promise.reject(new Error('db down'))),
};
const fakeRedis = {
  ping: () => (redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('redis down'))),
};

const config = testConfig({ LOG_LEVEL: 'info' });
const logs = captureLogs();
let app: INestApplication;
let base = '';

beforeAll(async () => {
  const logger = createLogger(config, logs.destination);
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot(config), LoggingModule.forRoot(logger), TelemetryModule],
    controllers: [ThingsController, HealthController],
    providers: [
      HealthService,
      { provide: DATABASE, useValue: fakeDatabase },
      { provide: REDIS, useValue: fakeRedis },
    ],
  }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(nest, config, logger);
  app = nest;
  base = await listenOnFreePort(app);
});

afterAll(async () => {
  await app.close();
});

const json = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('Zod request validation', () => {
  it('accepts a valid body and returns it', async () => {
    const response = await json('POST', '/things', { name: 'router', size: 3 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 'thing-1', name: 'router', size: 3 });
  });

  it('rejects an invalid body with 400 and does not reach the handler', async () => {
    const response = await json('POST', '/things', { name: '', size: -1 });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid query with 400', async () => {
    expect((await json('GET', '/things?q=a')).status).toBe(400);
    expect((await json('GET', '/things?q=ab')).status).toBe(200);
  });
});

describe('OpenAPI at /docs', () => {
  it('serves the Swagger UI', async () => {
    const response = await fetch(`${base}/docs`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('swagger-ui');
  });

  it('documents routes and request/response schemas generated from Zod', async () => {
    const document = (await (await fetch(`${base}/docs-json`)).json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health', '/health/ready', '/things']),
    );
    expect(document.paths['/metrics']).toBeUndefined();
    const created = JSON.stringify(document.paths['/things']?.post);
    expect(created).toContain('requestBody');
    expect(created).toContain('"size"');
    expect(JSON.stringify(document.paths['/health']?.get)).toContain('uptimeSeconds');
  });
});

describe('health', () => {
  it('liveness does not depend on Postgres or Redis', async () => {
    databaseUp = false;
    redisUp = false;
    try {
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', service: 'watchtower-api' });
    } finally {
      databaseUp = true;
      redisUp = true;
    }
  });

  it('readiness is 200 when both dependencies answer', async () => {
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('readiness is 503 and names the failing dependency, without leaking the error', async () => {
    redisUp = false;
    try {
      const response = await fetch(`${base}/health/ready`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as { checks: Record<string, { status: string }> };
      expect(body.checks.redis?.status).toBe('down');
      expect(body.checks.database?.status).toBe('up');
      expect(JSON.stringify(body)).not.toContain('redis down');
    } finally {
      redisUp = true;
    }
  });
});

describe('CORS', () => {
  const allowed = new URL(config.APP_URL).origin;

  it('allows the APP_URL origin, and only that origin, never *', async () => {
    const response = await fetch(`${base}/health`, { headers: { origin: allowed } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowed);
    expect(response.headers.get('access-control-expose-headers')).toContain('x-request-id');
  });

  it('sends no CORS headers to any other origin', async () => {
    for (const origin of ['http://evil.example.com', 'http://localhost:3001', 'null']) {
      const response = await fetch(`${base}/health`, { headers: { origin } });
      expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('answers a preflight from the allowed origin and refuses others', async () => {
    const preflight = (origin: string) =>
      fetch(`${base}/things`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    const ok = await preflight(allowed);
    expect(ok.status).toBeLessThan(300);
    expect(ok.headers.get('access-control-allow-origin')).toBe(allowed);
    expect(ok.headers.get('access-control-allow-methods')).toContain('POST');
    const refused = await preflight('http://evil.example.com');
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('observability', () => {
  it('echoes a safe x-request-id and replaces an unsafe one', async () => {
    const kept = await fetch(`${base}/health`, { headers: { 'x-request-id': 'abc-123' } });
    expect(kept.headers.get('x-request-id')).toBe('abc-123');
    const replaced = await fetch(`${base}/health`, {
      headers: { 'x-request-id': 'bad id\twith spaces' },
    });
    expect(replaced.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs requests as JSON without credentials, query strings or tokens', async () => {
    await fetch(`${base}/things?q=magic-link-token-9f8e`, {
      headers: { authorization: 'Bearer super-secret-bearer', cookie: 'session=cookie-secret' },
    });
    const raw = logs.raw();
    expect(raw).not.toContain('super-secret-bearer');
    expect(raw).not.toContain('cookie-secret');
    expect(raw).not.toContain('magic-link-token-9f8e');
    const entry = logs
      .lines()
      .findLast((line) => line.msg === 'request completed' && line.route === '/things');
    expect(entry).toMatchObject({
      level: 'info',
      req: { method: 'GET', path: '/things' },
      res: { statusCode: 200 },
    });
  });

  it('logs unhandled errors as 500 at error level', async () => {
    const response = await fetch(`${base}/things/boom`);
    expect(response.status).toBe(500);
    const entry = logs
      .lines()
      .find((line) => line.msg === 'request completed' && line.route === '/things/boom');
    expect(entry).toMatchObject({ level: 'error', res: { statusCode: 500 } });
  });

  it('exposes Prometheus metrics with the matched route as a label', async () => {
    await fetch(`${base}/health`);
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('http_server_request_duration_bucket');
    expect(text).toMatch(/http_route="\/health"/);
    expect(text).toContain('process_uptime');
    expect(text).toContain('process_resident_memory');
  });
});
