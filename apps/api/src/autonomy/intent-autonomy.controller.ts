import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
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
  PHASE_MAX_AUTONOMY_STAGE,
  idParamSchema,
  intentAutonomyChangeSchema,
  setIntentAutonomySchema,
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
    if (body.stage !== undefined && body.stage > PHASE_MAX_AUTONOMY_STAGE) {
      throw new ApiHttpError(
        403,
        'autonomy_stage_requires_owner',
        "Stage 3 and above (auto-send) cannot be set here: it is the owner's decision",
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
