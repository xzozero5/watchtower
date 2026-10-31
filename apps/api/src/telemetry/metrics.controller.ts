import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { TelemetryService } from './telemetry.service.js';

/**
 * Prometheus scrape endpoint. Public inside the compose network only: compose binds it to
 * 127.0.0.1 and the Caddyfile answers 404 for it. Not part of the OpenAPI document.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(TelemetryService) private readonly telemetry: TelemetryService) {}

  @Get()
  metrics(@Req() request: Request, @Res() response: Response): void {
    this.telemetry.writeMetrics(request, response);
  }
}
