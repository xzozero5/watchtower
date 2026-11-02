import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  convertOtherMailResultSchema,
  convertOtherMailSchema,
  idParamSchema,
  otherMailDetailSchema,
  otherMailPageSchema,
  otherMailQuerySchema,
  type ConvertOtherMail,
  type OtherMailQuery,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { OtherMailService } from './other-mail.service.js';

type IdParam = z.infer<typeof idParamSchema>;

/** "Other mail" (UI spec section 7): what did not become a ticket, and "this is a ticket". */
@ApiTags('inbound')
@Controller('v1/inbound/other-mail')
export class OtherMailController {
  constructor(@Inject(OtherMailService) private readonly mail: OtherMailService) {}

  @Get()
  @RequirePermission('inbound.read')
  // Addresses and the start of the text are personal data: every list is on the audit log (`pii.read`).
  @AuditPiiRead('inbound_message')
  @ApiOperation({
    summary: 'Received messages that did not become a ticket, newest first',
    description:
      'Noise, automatic replies (out of office, bounces) and internal or machine mail (PRD R-2.6, ' +
      'R-2.7). Filter by `disposition` and `channelAccountId`; `q` searches the sender, the subject ' +
      'and the beginning of the text. Each item carries the classifier verdict when there is one. ' +
      'Pass `nextCursor` back as `cursor`. Every list is on the audit log (`pii.read`).',
  })
  @ApiOkResponse({ standardSchema: otherMailPageSchema })
  async list(@Query({ schema: otherMailQuerySchema }) query: OtherMailQuery) {
    const page = await this.mail.list(query);
    AuditScope.set({ metadata: { resultCount: page.items.length } });
    return parseResponse(otherMailPageSchema, page);
  }

  @Get(':id')
  @RequirePermission('inbound.read')
  @AuditPiiRead('inbound_message')
  @ApiOperation({
    summary: 'One message of Other mail, with its text',
    description: 'The HTML part is never returned. 404 once the message became a ticket.',
  })
  @ApiOkResponse({ standardSchema: otherMailDetailSchema })
  @ApiNotFoundResponse({ description: 'No such message in Other mail' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    const detail = await this.mail.get(params.id);
    AuditScope.set({ targetId: detail.id });
    return parseResponse(otherMailDetailSchema, detail);
  }

  @Post(':id/convert')
  @HttpCode(200)
  // Opening a ticket is `ticket.create` work; reading the mail alone is not enough.
  @RequirePermission('inbound.read', 'ticket.create')
  @Audited({ action: AUDIT_ACTIONS.inboundConvert, targetType: 'inbound_message' })
  @ApiOperation({
    summary: 'This is a ticket: open a ticket from a message in Other mail',
    description:
      "Does what ingestion would have done for a person's mail: the sender becomes (or already is) a " +
      'contact, the message the first message of a new ticket. Nothing is sent to anybody, not even an ' +
      'acknowledgment. The row remembers what it was (`convertedFrom`) and who converted it. Asking ' +
      'again for a message already converted returns the same ticket. 409 for a message that is a ' +
      'ticket already, or whose organization is inactive.',
  })
  @ApiOkResponse({ standardSchema: convertOtherMailResultSchema })
  @ApiNotFoundResponse({ description: 'No such message' })
  @ApiConflictResponse({ description: 'Not in Other mail, or the organization is inactive' })
  async convert(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: convertOtherMailSchema }) body: ConvertOtherMail,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.mail.convert(params.id, body, {
      type: 'user',
      id: principal.userId,
    });
    return parseResponse(convertOtherMailResultSchema, result);
  }
}
