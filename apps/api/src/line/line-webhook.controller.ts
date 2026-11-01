import {
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { line } from '@watchtower/channels';
import type { Request } from 'express';
import { z } from 'zod';

import { Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { LineWebhookService } from './line-webhook.service.js';

const paramSchema = z.object({ channelAccountId: z.uuid() });
const resultSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});

/**
 * `POST /v1/inbound/line/:channelAccountId`: the webhook URL to paste into the LINE Developers
 * console for one Official Account. Public in the route policy because LINE has no session; it
 * authenticates itself with the HMAC signature over the raw body (R-2.9), which is checked before
 * anything else happens.
 */
@ApiTags('line')
@Controller('v1/inbound/line')
export class LineWebhookController {
  constructor(@Inject(LineWebhookService) private readonly webhook: LineWebhookService) {}

  @Post(':channelAccountId')
  @HttpCode(200)
  @Public()
  @ApiOperation({
    summary: 'LINE webhook for one Official Account',
    description:
      'Public, authenticated by `X-Line-Signature` (base64 HMAC-SHA256 of the raw body keyed with ' +
      'the channel secret). Each event is stored once, keyed by `webhookEventId`, and queued for the ' +
      'worker; a redelivery is answered 200 and ignored. Answers fast: nothing is processed here. ' +
      'Turn on "Use webhook" and "Webhook redelivery" in the LINE console (R-2.9).',
  })
  @ApiHeader({ name: line.LINE_SIGNATURE_HEADER, required: true })
  @ApiOkResponse({ standardSchema: resultSchema })
  @ApiUnauthorizedResponse({
    description: 'Unknown account, no channel secret, or wrong signature',
  })
  @ApiBadRequestResponse({ description: 'A signed body that is not a LINE webhook payload' })
  @ApiTooManyRequestsResponse({ description: 'Too many failed signatures from this address' })
  async receive(
    @Param({ schema: paramSchema }) params: z.infer<typeof paramSchema>,
    @Headers(line.LINE_SIGNATURE_HEADER) signature: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const result = await this.webhook.receive({
      channelAccountId: params.channelAccountId,
      rawBody: request.rawBody,
      signature,
      ip: request.ip ?? 'unknown',
    });
    return parseResponse(resultSchema, result);
  }
}
