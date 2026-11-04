import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  MANUAL_MAX_AUTONOMY_STAGE,
  autonomyHistoryPageSchema,
  autonomyHistoryQuerySchema,
  idParamSchema,
  intentAutonomyChangeSchema,
  setIntentAutonomySchema,
  type AutonomyHistoryQuery,
  type SetIntentAutonomy,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { ApiHttpError, forbidden } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { AutonomyService } from './autonomy.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('autonomy')
@Controller('v1/intents/:id/autonomy')
export class IntentAutonomyController {
  constructor(
    @Inject(AutonomyService) private readonly autonomy: AutonomyService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get('history')
  // `intent.manage` is what opens the Intents admin page (lead, head); the history is shown in it.
  // Reading it needs no write permission, so a lead who cannot pin still sees who pinned.
  @RequirePermission('intent.manage')
  @ApiOperation({
    summary: 'Stage and pin changes of an intent, newest first (lead, head)',
    description:
      'Who, when, from which stage to which, the pin state after it, and the reason given. Names ' +
      'are display names; `changedByName` is null when the account no longer exists. Keyset ' +
      'paginated: pass `nextCursor` back as `cursor`.',
  })
  @ApiOkResponse({ standardSchema: autonomyHistoryPageSchema })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async history(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Query({ schema: autonomyHistoryQuerySchema }) query: AutonomyHistoryQuery,
  ) {
    return parseResponse(autonomyHistoryPageSchema, await this.autonomy.history(params.id, query));
  }

  @Post()
  @HttpCode(200)
  @RequirePermission('ai.autonomy.set')
  @Audited({ action: AUDIT_ACTIONS.autonomyStageSet, targetType: 'intent' })
  @ApiOperation({
    summary: 'Change the autonomy stage of an intent (lead, head)',
    description:
      "Stage 0-2 only. Stage 3 and above (auto-send) is the owner's decision and is refused with " +
      '403 `autonomy_stage_requires_owner`, whoever asks. A reason is required and is kept with ' +
      'who/when/from/to in the history. `pinned` freezes or unfreezes the stage (head only: needs ' +
      '`ai.autonomy.set.any`); a pinned intent cannot change stage until unpinned, and no stage can ' +
      'be raised while the "limit to stage 2" switch is on (409).',
  })
  @ApiOkResponse({ standardSchema: intentAutonomyChangeSchema })
  @ApiForbiddenResponse({
    description: 'Stage 3 or above (autonomy_stage_requires_owner), or pinning without being head',
  })
  @ApiNotFoundResponse({ description: 'No such intent' })
  @ApiConflictResponse({ description: 'The intent is pinned, or the stage cap switch is on' })
  async set(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: setIntentAutonomySchema }) body: SetIntentAutonomy,
    @CurrentPrincipal() principal: Principal,
  ) {
    if (body.stage !== undefined && body.stage > MANUAL_MAX_AUTONOMY_STAGE) {
      throw new ApiHttpError(
        403,
        'autonomy_stage_requires_owner',
        'Stage 3 and above (auto-send) cannot be set here: it is reached by a promotion the owner approves',
      );
    }
    if (body.pinned !== undefined && !principal.permissions.has('ai.autonomy.set.any')) {
      throw forbidden('Only the head can pin or unpin an autonomy stage');
    }
    const result = await this.uow.run((uow) =>
      this.autonomy.setIntent(uow, { type: 'user', id: principal.userId }, params.id, body),
    );
    return parseResponse(intentAutonomyChangeSchema, result);
  }
}
