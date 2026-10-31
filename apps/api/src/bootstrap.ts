import 'reflect-metadata';

import { StandardSchemaValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
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
  // The browser app calls the API across origins (web on APP_URL, api on API_URL). Allow-list of
  // exactly one origin; never `*`. Requests from any other origin get no CORS headers.
  app.enableCors({
    origin: [new URL(config.APP_URL).origin],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });
  app.use(observability(logger, app.get(TelemetryService)));
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
        .build(),
    );
    SwaggerModule.setup(DOCS_PATH, app, document);
  }
}

/** Builds the application without listening, so tests can drive it on an ephemeral port. */
export async function createApp(
  config: ApiConfig,
  logger: AppLogger,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger), {
    bufferLogs: true,
    logger: new NestPinoLogger(logger),
  });
  configureApp(app, config, logger);
  return app;
}
