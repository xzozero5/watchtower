import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  channelAccountIdParamSchema,
  channelAccountListSchema,
  channelAccountSchema,
  createChannelAccountSchema,
  type ChannelAccountIdParam,
  type CreateChannelAccount,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { ChannelAccountsService } from './channel-accounts.service.js';

/**
 * LINE Official Accounts and Gmail mailboxes, `head` only (`integration.manage`, T-131). The
 * credentials of an integration are saved under `/v1/admin/integrations`; this registers the
 * account they connect to. No response carries a credential value.
 */
@ApiTags('admin')
@Controller('v1/admin/channel-accounts')
@RequirePermission('integration.manage')
export class ChannelAccountsController {
  constructor(@Inject(ChannelAccountsService) private readonly accounts: ChannelAccountsService) {}

  @Get()
  @ApiOperation({
    summary: 'LINE accounts and Gmail mailboxes (head)',
    description:
      'Every registered LINE Official Account and Gmail mailbox, switched off ones included ' +
      '(`enabled: false`). For a LINE account `webhookUrl` is the address to paste into the LINE ' +
      'Developers console; `credentials` says whether the integration has everything it needs.',
  })
  @ApiOkResponse({ standardSchema: channelAccountListSchema })
  async list() {
    return parseResponse(channelAccountListSchema, await this.accounts.list());
  }

  @Post()
  @Audited({ action: AUDIT_ACTIONS.channelAccountCreate, targetType: 'channel_account' })
  @ApiOperation({
    summary: 'Register a LINE account or a Gmail mailbox (head)',
    description:
      'LINE: `{ type: "line", name }`. The response carries `webhookUrl`. An instance holds one LINE ' +
      'channel secret (ADR-012), so a second active LINE account is refused with 409; disable the ' +
      'first one before registering another. Gmail: `{ type: "gmail", name, emailAddress }`; several ' +
      'mailboxes are allowed, each address once.',
  })
  @ApiCreatedResponse({ standardSchema: channelAccountSchema })
  @ApiBadRequestResponse({ description: 'Unknown type, missing or extra field, bad address' })
  @ApiConflictResponse({
    description: 'A second active LINE account, or the mailbox already exists',
  })
  async create(
    @Body({ schema: createChannelAccountSchema }) body: CreateChannelAccount,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(channelAccountSchema, await this.accounts.create(body, principal.userId));
  }

  @Post(':id/disable')
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.channelAccountDisable, targetType: 'channel_account' })
  @ApiOperation({
    summary: 'Switch an account off (head)',
    description:
      'A LINE webhook for it is refused from now on; a mailbox stops syncing. Nothing is deleted ' +
      '(tickets and deliveries refer to it). Repeating the call changes nothing.',
  })
  @ApiOkResponse({ standardSchema: channelAccountSchema })
  @ApiNotFoundResponse({ description: 'No such account' })
  @ApiBadRequestResponse({ description: 'Not a LINE or Gmail account' })
  async disable(
    @Param({ schema: channelAccountIdParamSchema }) params: ChannelAccountIdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      channelAccountSchema,
      await this.accounts.disable(params.id, principal.userId),
    );
  }
}
