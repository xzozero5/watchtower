import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiBadRequestResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  autonomyStateSchema,
  setAiSwitchResultSchema,
  setAiSwitchSchema,
  type SetAiSwitch,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { AutonomyService } from './autonomy.service.js';

@ApiTags('autonomy')
@Controller('v1/autonomy')
export class AutonomyController {
  constructor(
    @Inject(AutonomyService) private readonly autonomy: AutonomyService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'Autonomy stages and the AI switches',
    description:
      'Every intent with its stage (0-3; 3 only after a promotion), the stage the system acts on (`effectiveStage`: at most 2 unless `autosendFlag` is true), its auto-send settings, whether ' +
      'it is pinned, and the two global switches with who flipped them last and why. Staff use it ' +
      'to show the "AI paused" banner and the stage badge.',
  })
  @ApiOkResponse({ standardSchema: autonomyStateSchema })
  async state() {
    return parseResponse(autonomyStateSchema, await this.autonomy.read());
  }

  @Post('switches')
  @HttpCode(200)
  // Head only: `ai.emergency_switch` alone is also held by leads (T-123a matrix); `ai.autonomy.set.any`
  // only by the head. Both are required, which is what UI spec 6.5 asks for [ASSUMED, see ADR-011].
  @RequirePermission('ai.emergency_switch', 'ai.autonomy.set.any')
  @Audited({ action: AUDIT_ACTIONS.autonomySwitchSet, targetType: 'ai_switch' })
  @ApiOperation({
    summary: 'Turn an AI switch on or off (head)',
    description:
      '`ai_stage_cap_pinned` ("limit all intents to stage 2 or lower") blocks raising any stage ' +
      'and never raises a stage 0 or 1. `ai_kill_switch` ("stop all AI runs") stops classification, ' +
      'investigation and drafts; automatic acknowledgments from safe templates continue. A reason is ' +
      'required in both directions; both are audited. Asking for the value it already has changes ' +
      'nothing (`changed: false`).',
  })
  @ApiOkResponse({ standardSchema: setAiSwitchResultSchema })
  @ApiBadRequestResponse({ description: 'Missing or too short reason' })
  async setSwitch(
    @Body({ schema: setAiSwitchSchema }) body: SetAiSwitch,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.setSwitch(uow, { type: 'user', id: principal.userId }, body),
    );
    return parseResponse(setAiSwitchResultSchema, result);
  }
}
