import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { Public } from '../auth/decorators.js';
import { livenessSchema, readinessSchema, type Liveness, type Readiness } from './health.schema.js';
import { HealthService } from './health.service.js';

@ApiTags('health')
// Probes carry no credentials.
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness',
    description: 'The process is up. Touches no dependency, so it is safe as a liveness probe.',
  })
  @ApiOkResponse({ standardSchema: livenessSchema })
  liveness(): Liveness {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness',
    description: 'Postgres and Redis answer. Responds 503 with the same body when one is down.',
  })
  @ApiOkResponse({ standardSchema: readinessSchema })
  @ApiServiceUnavailableResponse({ standardSchema: readinessSchema })
  async readiness(): Promise<Readiness> {
    const readiness = await this.health.readiness();
    if (readiness.status !== 'ok') throw new ServiceUnavailableException(readiness);
    return readiness;
  }
}
