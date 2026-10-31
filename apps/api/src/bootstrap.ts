import 'reflect-metadata';

import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ACCESS_COOKIE, CSRF_HEADER, PORTAL_TOKEN_HEADER } from '@watchtower/shared';

import { AppModule, type AppOptions } from './app.module.js';
import { COOKIE_AUTH_SCHEME } from './auth/decorators.js';
import { originCheck } from './auth/origin.middleware.js';
import type { ApiConfig } from './config/config.js';
import { observability } from './http/observability.middleware.js';
import { NestPinoLogger, type AppLogger } from './logging/logger.js';
import { TelemetryService } from './telemetry/telemetry.service.js';

export const DOCS_PATH = 'docs';

/**
 * Cross-cutting HTTP setup shared by the real app and by tests that build their own module:
 * access log + metrics + trace, Zod validation, shutdown hooks and the OpenAPI document.
 */
export function configureApp(
  app: NestExpressApplication,
  config: ApiConfig,
  logger: AppLogger,
): void {
  app.disable('x-powered-by');
  // How many reverse proxies to trust for the client IP (audit log, rate limits). Default 0: the
  // socket address, which cannot be spoofed with an X-Forwarded-For header.
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  // The browser app calls the API across origins (web on APP_URL, api on API_URL) with cookies.
  // Allow-list of exactly one origin; never `*`, and credentials only for that origin. Requests
  // from any other origin get no CORS headers, so a browser will not hand them a response.
  app.enableCors({
    origin: [new URL(config.APP_URL).origin],
    credentials: true,
    allowedHeaders: ['content-type', CSRF_HEADER, PORTAL_TOKEN_HEADER, 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
    maxAge: 600,
  });
  app.use(observability(logger, app.get(TelemetryService)));
  // Refuse unsafe requests that a browser says came from another site (CSRF, third layer).
  app.use(originCheck(config, logger));
  // Request input is validated with the Zod schema attached to @Body/@Query/@Param.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  if (config.docsEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Watchtower API')
        .setDescription('Tech Operations AI Command Center. Generated from Zod schemas.')
        .setVersion('0.0.0')
        .addServer(config.API_URL)
        .addCookieAuth(
          ACCESS_COOKIE,
          { type: 'apiKey', in: 'cookie', name: ACCESS_COOKIE },
          COOKIE_AUTH_SCHEME,
        )
        .build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, document);
  }
}

/** Builds the application without listening, so tests can drive it on an ephemeral port. */
export async function createApp(
  config: ApiConfig,
  logger: AppLogger,
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, logger, options),
    {
      bufferLogs: true,
      logger: new NestPinoLogger(logger),
    },
  );
  configureApp(app, config, logger);
  return app;
}
