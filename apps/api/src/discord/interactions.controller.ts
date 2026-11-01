import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { discord } from '@watchtower/channels';
import type { Request } from 'express';
import { z } from 'zod';

import { Public } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DiscordInteractionsService } from './interactions.service.js';

/** The shape of an interaction response (Discord's `type` and optional `data`); the content is built by the service. */
const { INTERACTION_SIGNATURE_HEADER, INTERACTION_TIMESTAMP_HEADER } = discord;

const interactionResponseSchema = z.object({
  type: z.number().int(),
  data: z
    .object({
      content: z.string(),
      flags: z.number().int().optional(),
      components: z.array(z.unknown()).optional(),
      allowed_mentions: z.object({ parse: z.array(z.never()) }),
    })
    .optional(),
});

/**
 * Where Discord posts interactions (T-202b). Public in the route policy because Discord has no
 * session; the Ed25519 signature is the authentication and is checked before anything is read.
 */
@ApiTags('discord')
@Controller('v1/inbound/discord')
export class DiscordInteractionsController {
  constructor(
    @Inject(DiscordInteractionsService) private readonly interactions: DiscordInteractionsService,
  ) {}

  @Post('interactions')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Discord interactions endpoint: buttons and slash commands',
    description:
      'Called by Discord only. Authenticated by X-Signature-Ed25519 over X-Signature-Timestamp plus the ' +
      'raw body, with the application public key from the credential store. A PING is answered with ' +
      '{"type":1}. A button on an alert page acknowledges that alert; buttons on an incident thread ' +
      'acknowledge its alerts or make the presser commander; /ack and /incident work the same way. The ' +
      'Discord account must be linked to an active staff user (users.discord_user_id): an unlinked one ' +
      'is refused and nothing changes. The same interaction id is handled once. The answer is built ' +
      'within the 3 seconds Discord allows and holds ids, enumerations and counts only. 401 bad ' +
      'signature, 400 not an interaction, 429 over the per-IP limit, 503 no public key configured.',
  })
  @ApiHeader({ name: INTERACTION_SIGNATURE_HEADER, required: true })
  @ApiHeader({ name: INTERACTION_TIMESTAMP_HEADER, required: true })
  @ApiOkResponse({ standardSchema: interactionResponseSchema })
  @ApiUnauthorizedResponse({ description: 'Signature missing or invalid' })
  @ApiBadRequestResponse({ description: 'Authentic but not an interaction' })
  @ApiTooManyRequestsResponse({ description: 'Per-IP rate limit' })
  @ApiServiceUnavailableResponse({ description: 'No public key configured' })
  async interactionsEndpoint(
    @Headers(INTERACTION_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(INTERACTION_TIMESTAMP_HEADER) timestamp: string | undefined,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const response = await this.interactions.handle({
      rawBody: request.rawBody,
      signature,
      timestamp,
      ip: request.ip ?? null,
    });
    return parseResponse(interactionResponseSchema, response);
  }
}
