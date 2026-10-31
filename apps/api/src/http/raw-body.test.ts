import { Body, Controller, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { disableNetConnect } from '@watchtower/shared/testing';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { NEST_APP_OPTIONS, configureApp } from '../bootstrap.js';
import { AppConfigModule } from '../config/config.module.js';
import { createLogger } from '../logging/logger.js';
import { LoggingModule } from '../logging/logging.module.js';
import { TelemetryModule } from '../telemetry/telemetry.module.js';
import { listenOnFreePort, testConfig } from '../testing/support.js';

// Webhook signatures (LINE HMAC, Discord Ed25519) are computed over the exact bytes the sender
// posted, so the api keeps them next to the parsed body (NEST_APP_OPTIONS.rawBody, T-123a).

const eventSchema = z.object({ name: z.string(), n: z.number() });

@Controller('probe')
class RawBodyProbeController {
  @Post('hook')
  hook(
    @Body({ schema: eventSchema }) body: z.infer<typeof eventSchema>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return { body, raw: req.rawBody?.toString('utf8') ?? null };
  }
}

const config = testConfig();
let app: NestExpressApplication;
let base = '';
// Sample use of the network guard: this test talks to its own server only, and fails if anything
// in the stack under test tries to reach another machine.
const netGuard = disableNetConnect();

beforeAll(async () => {
  const logger = createLogger(config);
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot(config), LoggingModule.forRoot(logger), TelemetryModule],
    controllers: [RawBodyProbeController],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS);
  configureApp(app, config, logger);
  base = await listenOnFreePort(app);
});

afterAll(async () => {
  await app.close();
  expect(netGuard.blocked()).toEqual([]);
  netGuard.restore();
});

const post = (body: string, contentType = 'application/json') =>
  fetch(`${base}/probe/hook`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });

describe('rawBody', () => {
  it('is on in the options the application is created with', () => {
    expect(NEST_APP_OPTIONS.rawBody).toBe(true);
  });

  it('still parses and validates JSON, and also exposes the exact bytes that were sent', async () => {
    // Odd spacing and non-ASCII text: a re-serialized body would not match these bytes.
    const sent = '{ "name":"สวัสดี",   "n": 1 }';
    const response = await post(sent);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: { name: 'สวัสดี', n: 1 }, raw: sent });
  });

  it('still refuses a body that does not match the schema, and malformed JSON', async () => {
    expect((await post('{"name":"x"}')).status).toBe(400);
    expect((await post('{"name":')).status).toBe(400);
  });
});
