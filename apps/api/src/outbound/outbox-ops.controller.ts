import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  deadOutboxPageSchema,
  deadOutboxQuerySchema,
  idParamSchema,
  outboxHealthSchema,
  resendOutboxResultSchema,
  type DeadOutboxQuery,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { OutboxOpsService } from './outbox-ops.service.js';

type IdParam = z.infer<typeof idParamSchema>;

/**
 * The transactional outbox as the head sees it (T-121a, PRD section 8.3, docs/09-SECURITY.md section 6):
 * how late the oldest waiting job is, and the rows that were given up on. Head only (`outbox.manage`).
 * None of it carries a job payload.
 */
@ApiTags('ops')
@Controller('v1/ops/outbox')
export class OutboxOpsController {
  constructor(@Inject(OutboxOpsService) private readonly ops: OutboxOpsService) {}

  @Get()
  @RequirePermission('outbox.manage')
  @ApiOperation({
    summary: 'Outbox health: backlog, dead rows and the age of the oldest waiting job (head)',
    description:
      '`oldestPendingSeconds` counts from the moment the oldest pending row became due (a send waiting ' +
      'out its undo window is not late). `status` is `warning` from 2 minutes and `critical` from 10 ' +
      'minutes `[ASSUMED]`: the relay polls every second, so a job that waits that long means the ' +
      'relay or Redis is down. Counts only; no payload.',
  })
  @ApiOkResponse({ standardSchema: outboxHealthSchema })
  async health() {
    return parseResponse(outboxHealthSchema, await this.ops.health());
  }

  @Get('dead')
  @RequirePermission('outbox.manage')
  @ApiOperation({
    summary: 'Outbox rows that were given up on, newest first (head)',
    description:
      'The dead-letter list. A row has the queue, the job, how many times it was tried and the last ' +
      'error (one line, never a payload). `replayable` says whether "resend" can rebuild the job from ' +
      'its source record; if not, `notReplayableReason` says why. Pass `nextCursor` back as `cursor`.',
  })
  @ApiOkResponse({ standardSchema: deadOutboxPageSchema })
  async dead(@Query({ schema: deadOutboxQuerySchema }) query: DeadOutboxQuery) {
    return parseResponse(deadOutboxPageSchema, await this.ops.listDead(query));
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RequirePermission('outbox.manage')
  @Audited({ action: AUDIT_ACTIONS.outboxResend, targetType: 'outbox' })
  @ApiOperation({
    summary: 'Put a dead outbox row back in the queue (head)',
    description:
      'Rebuilds the job from its source record (a delivery still waiting to be sent, a received event ' +
      'not yet processed) and makes the row pending again with a new job id; the relay picks it up ' +
      'within a second. It never sends a customer anything by itself: the consumer checks the same ' +
      'conditions it always does, including the undo window and the policy gate. ' +
      '409 when the row is not dead or cannot be rebuilt. Audited with the old and new job id.',
  })
  @ApiOkResponse({ standardSchema: resendOutboxResultSchema })
  @ApiNotFoundResponse({ description: 'No such outbox row' })
  @ApiConflictResponse({ description: 'The row is not dead, or it cannot be rebuilt' })
  async resend(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      resendOutboxResultSchema,
      await this.ops.resend(params.id, principal.userId),
    );
  }
}
