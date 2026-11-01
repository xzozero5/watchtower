import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  alertAckResultSchema,
  alertDetailSchema,
  alertEscalationListSchema,
  alertIdParamSchema,
  alertListQuerySchema,
  alertListSchema,
  unmappedAlertsSchema,
  type AlertIdParam,
  type AlertListQuery,
} from '@watchtower/shared';

import { CurrentPrincipal, RequirePermission, type Principal } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { AlertsActions } from './alerts-actions.service.js';
import { AlertsReader } from './alerts-reader.service.js';

/** Alerts for staff (`alert.read`): the list, one alert with its deliveries, and the unmapped bucket. */
@ApiTags('alerts')
@Controller('v1/alerts')
@RequirePermission('alert.read')
export class AlertsController {
  constructor(
    @Inject(AlertsReader) private readonly reader: AlertsReader,
    @Inject(AlertsActions) private readonly actions: AlertsActions,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

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

  @Get(':id/escalations')
  @ApiOperation({
    summary: 'The escalation steps carried out for an alert',
    description:
      'One entry per step of the escalation policy already done: who was told (a count, never names), ' +
      'whether nobody was on shift and the leads were told instead, and how the chat post went ' +
      '("mock" means a fake recorded it and nothing was delivered).',
  })
  @ApiOkResponse({ standardSchema: alertEscalationListSchema })
  @ApiNotFoundResponse({ description: 'No such alert' })
  async escalations(@Param({ schema: alertIdParamSchema }) params: AlertIdParam) {
    return parseResponse(alertEscalationListSchema, {
      items: await this.reader.escalations(params.id),
    });
  }

  @Post(':id/ack')
  @HttpCode(200)
  @RequirePermission('alert.ack')
  @ApiOperation({
    summary: 'Acknowledge an alert',
    description:
      'Stops the escalation (R-3.8). If somebody acknowledged first, or the alert is resolved, nothing ' +
      'changes and "changed" is false; this is not an error. Staff see the change in realtime. ' +
      'The audit row is written only for the press that changed the alert.',
  })
  @ApiOkResponse({ standardSchema: alertAckResultSchema })
  @ApiNotFoundResponse({ description: 'No such alert' })
  async ack(
    @Param({ schema: alertIdParamSchema }) params: AlertIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { changed } = await this.uow.run((uow) =>
      this.actions.ack(uow, { type: 'user', id: principal.userId }, params.id, 'web'),
    );
    return parseResponse(alertAckResultSchema, {
      changed,
      alert: await this.reader.getOne(params.id),
    });
  }
}
