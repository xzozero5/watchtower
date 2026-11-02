import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { AUDIT_ACTIONS, gmailManualSyncResultSchema } from '@watchtower/shared';

import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { GmailSyncService } from './gmail-sync.service.js';

/** Manual Gmail sync (T-150), `head` only (`integration.manage`). */
@ApiTags('admin')
@Controller('v1/admin/integrations/gmail/sync')
@RequirePermission('integration.manage')
export class GmailSyncController {
  constructor(@Inject(GmailSyncService) private readonly sync: GmailSyncService) {}

  @Post()
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.gmailManualSync, targetType: 'integration', always: true })
  @ApiOperation({
    summary: 'Sync the Gmail mailbox now (head)',
    description:
      'Queues a `sync` job with reason `manual` for every enabled Gmail mailbox, the same job a push ' +
      'or the heartbeat queues, so a mailbox whose push stopped can be recovered without ' +
      'reconnecting. Answers at once with what was queued; the sync runs in the worker. A mailbox ' +
      'queued less than a minute ago is listed under `throttled` and skipped. 409 when no enabled ' +
      'mailbox exists; 429 (`Retry-After`) when every enabled mailbox was queued in the last minute.',
  })
  @ApiOkResponse({ standardSchema: gmailManualSyncResultSchema })
  @ApiConflictResponse({ description: 'No enabled Gmail mailbox' })
  @ApiTooManyRequestsResponse({
    description: 'Every enabled mailbox was synced by hand in the last minute',
  })
  async syncNow() {
    return parseResponse(gmailManualSyncResultSchema, await this.sync.syncNow());
  }
}
