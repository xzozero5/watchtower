import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ALERT_WEBHOOK_SIGNATURE_HEADER,
  alertIngestResultSchema,
  heartbeatBeatResultSchema,
  heartbeatSlugParamSchema,
  type HeartbeatSlugParam,
} from '@watchtower/shared';
import type { Request } from 'express';

import { Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AlertIngestService } from './alerts-ingest.service.js';

/**
 * Where alerts come in (T-201c). Public in the route policy because the senders have no session;
 * each route authenticates its caller before it reads the body (see `AlertIngestService`).
 */
@ApiTags('alerts')
@Controller('v1/inbound/alerts')
export class AlertsIngestController {
  constructor(@Inject(AlertIngestService) private readonly ingest: AlertIngestService) {}

  @Post('gcp')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'GCP alert notification from Pub/Sub',
    description:
      'Called by Pub/Sub only. Needs `Authorization: Bearer <OIDC token>` signed by the push service ' +
      'account of the subscription for the configured audience. The message is a Cloud Monitoring ' +
      'notification (metric or log-based alert). The Pub/Sub `messageId` is the idempotency key: a ' +
      'redelivery is answered 200 and not counted, a second real fire raises the count of the open ' +
      'alert, `closed` resolves it. Unreadable but authentic messages are acknowledged and dropped ' +
      '(`ignored`). 401 for a bad token (nothing is written), 429 over the per-IP limit, 503 when push ' +
      'authentication is not configured or Google keys cannot be fetched.',
  })
  @ApiOkResponse({ standardSchema: alertIngestResultSchema })
  @ApiUnauthorizedResponse({ description: 'Token missing or invalid' })
  @ApiTooManyRequestsResponse({ description: 'Per-IP rate limit' })
  @ApiServiceUnavailableResponse({ description: 'Not configured, or keys unavailable' })
  async gcp(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    // The body is deliberately not validated by a pipe: a message that passed authentication but cannot
    // be read must be acknowledged, not rejected (poison message).
    const result = await this.ingest.acceptGcp({ authorization, body, ip: request.ip ?? null });
    return parseResponse(alertIngestResultSchema, result);
  }

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Alertmanager-compatible alert webhook',
    description:
      'Public, authenticated by `X-Watchtower-Signature: t=<unix seconds>,v1=<hex>` where `v1` is ' +
      'HMAC-SHA256 of `"<t>." + raw body` keyed with the alerting webhook secret; `t` must be within ' +
      '5 minutes of the server clock. Alertmanager payload version 4: each alert is applied once ' +
      '(keyed by fingerprint, `startsAt` and status), so a repeat notification is a duplicate and ' +
      '`resolved` closes the open alert. Alertmanager cannot sign a body itself, so a relay is needed.',
  })
  @ApiHeader({ name: ALERT_WEBHOOK_SIGNATURE_HEADER, required: true })
  @ApiOkResponse({ standardSchema: alertIngestResultSchema })
  @ApiUnauthorizedResponse({ description: 'No secret set, or the signature is missing or wrong' })
  @ApiBadRequestResponse({ description: 'A signed body that is not an Alertmanager payload' })
  @ApiTooManyRequestsResponse({ description: 'Per-IP rate limit' })
  async webhook(
    @Headers(ALERT_WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const result = await this.ingest.acceptWebhook({
      rawBody: request.rawBody,
      signature,
      ip: request.ip ?? null,
    });
    return parseResponse(alertIngestResultSchema, result);
  }
}

/**
 * Where a heartbeat signal comes in (R-3.10, T-201e). Public in the route policy: the sender has no
 * session and authenticates with the same HMAC signature as the alert webhook.
 */
@ApiTags('alerts')
@Controller('v1/inbound/heartbeats')
export class HeartbeatBeatController {
  constructor(@Inject(AlertIngestService) private readonly ingest: AlertIngestService) {}

  @Post(':slug')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'A heartbeat signal',
    description:
      'Public, authenticated by the X-Watchtower-Signature header exactly as the alert ' +
      'webhook (HMAC-SHA256 of "<t>." + raw body; send a JSON body such as {}). Stamps the heartbeat with ' +
      'the database clock; if it was missing, it is ok again and its alert is resolved (recovered: true). ' +
      '401 for a bad or missing signature, 404 for a slug that does not exist, 429 over the per-IP limit.',
  })
  @ApiHeader({ name: ALERT_WEBHOOK_SIGNATURE_HEADER, required: true })
  @ApiOkResponse({ standardSchema: heartbeatBeatResultSchema })
  @ApiUnauthorizedResponse({ description: 'No secret set, or the signature is missing or wrong' })
  @ApiNotFoundResponse({ description: 'No such heartbeat' })
  @ApiTooManyRequestsResponse({ description: 'Per-IP rate limit' })
  async beat(
    @Param({ schema: heartbeatSlugParamSchema }) params: HeartbeatSlugParam,
    @Headers(ALERT_WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const result = await this.ingest.acceptHeartbeat({
      slug: params.slug,
      rawBody: request.rawBody,
      signature,
      ip: request.ip ?? null,
    });
    return parseResponse(heartbeatBeatResultSchema, result);
  }
}
