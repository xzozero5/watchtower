import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  alertDetailSchema,
  alertIdParamSchema,
  alertListQuerySchema,
  alertListSchema,
  unmappedAlertsSchema,
  type AlertIdParam,
  type AlertListQuery,
} from '@watchtower/shared';

import { RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AlertsReader } from './alerts-reader.service.js';

/** Alerts for staff (`alert.read`): the list, one alert with its deliveries, and the unmapped bucket. */
@ApiTags('alerts')
@Controller('v1/alerts')
@RequirePermission('alert.read')
export class AlertsController {
  constructor(@Inject(AlertsReader) private readonly reader: AlertsReader) {}

  @Get()
  @ApiOperation({
    summary: 'List alerts, newest activity first',
    description:
      'Filter by `state` (`open`, `acknowledged`, `resolved`), `source`, `serviceId` or `unmapped=true` ' +
      '(alerts no service claims). Keyset pagination: pass `nextCursor` back as `cursor`. `payload` holds ' +
      'allow-listed keys only.',
  })
  @ApiOkResponse({ standardSchema: alertListSchema })
  async list(@Query({ schema: alertListQuerySchema }) query: AlertListQuery) {
    return parseResponse(alertListSchema, await this.reader.list(query));
  }

  // Declared before `:id` so that "unmapped" is not read as an alert id.
  @Get('unmapped')
  @ApiOperation({
    summary: 'Alerts no service claims, grouped (R-3.7)',
    description:
      'Alerts from the last 7 days with no service, grouped by source and title, so a lead can add a ' +
      'service or a match rule. The window is measured on the database clock.',
  })
  @ApiOkResponse({ standardSchema: unmappedAlertsSchema })
  async unmapped() {
    return parseResponse(unmappedAlertsSchema, await this.reader.unmapped());
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One alert with the deliveries that changed it',
    description: 'Each event is one provider delivery: `fired`, `renotified` or `resolved`.',
  })
  @ApiOkResponse({ standardSchema: alertDetailSchema })
  @ApiNotFoundResponse({ description: 'No such alert' })
  async get(@Param({ schema: alertIdParamSchema }) params: AlertIdParam) {
    return parseResponse(alertDetailSchema, await this.reader.get(params.id));
  }
}
