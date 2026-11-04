import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
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
  applyPromotionResultSchema,
  autonomyPromotionStateSchema,
  autosendDisclosureSchema,
  decidePromotionResultSchema,
  decidePromotionSchema,
  gateReportListSchema,
  gateReportSchema,
  idParamSchema,
  intentAutosendSchema,
  promotionListSchema,
  promotionSchema,
  requestPromotionSchema,
  setAutosendDisclosureSchema,
  setIntentAutosendSchema,
  type DecidePromotion,
  type RequestPromotion,
  type SetAutosendDisclosure,
  type SetIntentAutosend,
} from '@watchtower/shared';
import { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { AutonomyService } from './autonomy.service.js';

type IdParam = z.infer<typeof idParamSchema>;
const promotionParamSchema = z.object({ promotionId: z.uuid() });
type PromotionParam = z.infer<typeof promotionParamSchema>;
const reportsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) });
type ReportsQuery = z.infer<typeof reportsQuerySchema>;

const autosendResultSchema = z.object({ changed: z.boolean(), autosend: intentAutosendSchema });

/**
 * Stage 3 per intent (ADR-025, T-304f): the gate report, the promotion door (a head asks, the owner approves
 * with a sign-in from the last 5 minutes and the typed key of the intent), and the auto-send settings.
 * Nothing here changes `AI_AUTOSEND_ENABLED`: it is read-only (`autosendFlag` in `GET /v1/autonomy`).
 */
@ApiTags('autonomy')
@Controller('v1/intents/:id/autonomy')
export class IntentPromotionController {
  constructor(
    @Inject(AutonomyService) private readonly autonomy: AutonomyService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get('promotion')
  @RequirePermission('intent.manage')
  @ApiOperation({
    summary: 'The promotion door of one intent: the latest gate report and the open request',
    description:
      '`autosendFlag` false means a request answers 409 `autosend_flag_off`. `openPromotion` is a request that waits for the owner (`requested`) or an approval not yet applied (`approved`, valid 72 hours).',
  })
  @ApiOkResponse({ standardSchema: autonomyPromotionStateSchema })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async state(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(
      autonomyPromotionStateSchema,
      await this.autonomy.promotionState(params.id),
    );
  }

  @Get('gate-reports')
  @RequirePermission('intent.manage')
  @ApiOperation({
    summary: 'Gate reports of an intent, newest first',
    description:
      'Each criterion has `pass` true, false or null (not enough data), a `value`, a `threshold` and its `basis` (`PRD` or `ASSUMED`). `status` is green only when every deciding criterion passes over a window of at least 28 days at stage 2; seed data is never counted. The replay and redaction eval criteria are listed with `not_measured`.',
  })
  @ApiOkResponse({ standardSchema: gateReportListSchema })
  async reports(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Query({ schema: reportsQuerySchema }) query: ReportsQuery,
  ) {
    return parseResponse(gateReportListSchema, {
      items: await this.autonomy.reports(params.id, query.limit),
    });
  }

  @Post('gate-reports')
  @HttpCode(200)
  @RequirePermission('ai.autonomy.promote')
  @ApiOperation({
    summary: 'Make a gate report now (head)',
    description:
      'Reads the tables and writes one append-only report row with an audit entry. It changes no stage.',
  })
  @ApiOkResponse({ standardSchema: gateReportSchema })
  async createReport(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      gateReportSchema,
      await this.autonomy.createReport({ type: 'user', id: principal.userId }, params.id),
    );
  }

  @Get('promotions')
  @RequirePermission('intent.manage')
  @ApiOperation({ summary: 'Promotion requests of an intent, newest first (last 20)' })
  @ApiOkResponse({ standardSchema: promotionListSchema })
  async promotions(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(promotionListSchema, { items: await this.autonomy.promotions(params.id) });
  }

  @Post('promotions')
  @HttpCode(200)
  @RequirePermission('ai.autonomy.promote')
  @Audited({ action: AUDIT_ACTIONS.autonomyPromotionRequested, targetType: 'intent' })
  @ApiOperation({
    summary: 'Ask the owner to move an intent to stage 3 (head)',
    description:
      'Needs a green gate report of this intent (at most 7 days old, a window of 28 days at stage 2). 409 `autosend_flag_off` when the instance does not run with AI_AUTOSEND_ENABLED; 409 when a request is already open; 403 `forbidden`/`policy_denied` with a `reason` code from the database when the intent is not eligible (`report_not_green`, `window_not_at_stage_2`, `pinned`, `stage_cap_on`, ...).',
  })
  @ApiOkResponse({ standardSchema: promotionSchema })
  @ApiConflictResponse({ description: 'autosend_flag_off, or a request is already open' })
  async request(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: requestPromotionSchema }) body: RequestPromotion,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.requestPromotion(uow, { type: 'user', id: principal.userId }, params.id, body),
    );
    return parseResponse(promotionSchema, result);
  }

  @Put('autosend')
  @RequirePermission('ai.autonomy.set.any')
  @ApiOperation({
    summary: 'Change the auto-send settings of an intent (head)',
    description:
      'Shadow mode (grade every draft as if it could go out, send nothing), the minimum score (0.70-1.00), the daily cap and the allow-list policy (`channels` is a subset of gmail and portal; the default is no channel). A reason is required and kept in the history. On an intent at stage 3, loosening any rule is allowed only here.',
  })
  @ApiOkResponse({ standardSchema: autosendResultSchema })
  async setAutosend(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: setIntentAutosendSchema }) body: SetIntentAutosend,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.setAutosend(uow, { type: 'user', id: principal.userId }, params.id, body),
    );
    return parseResponse(autosendResultSchema, result);
  }
}

@ApiTags('autonomy')
@Controller('v1/autonomy')
export class PromotionDecisionController {
  constructor(
    @Inject(AutonomyService) private readonly autonomy: AutonomyService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Post('promotions/:promotionId/decide')
  @HttpCode(200)
  @RequireAnyPermission('ai.autonomy.owner_approve', 'ai.autonomy.promote')
  @Audited({ action: AUDIT_ACTIONS.autonomyPromotionDecided, targetType: 'intent' })
  @ApiOperation({
    summary: 'Approve, reject or withdraw a promotion request',
    description:
      'Approving is for the holder of `ai.autonomy.owner_approve` only (403 `owner_only`), needs `confirmKey` (the key of the intent, typed) and a step-up at Google from the last 5 minutes (T-306a C-5): the browser goes through `GET /v1/auth/google/step-up` (prompt=login, max_age=300, auth_time checked), which stores the result on the session; a session that is merely new, a magic link or a break-glass sign-in does not count, and the answer is 403 `reauth_required`. A development stack without Google (mock mode) falls back to the age of the session. The audit row names the method (`reauthMethod`). The owner may approve a request of their own (`selfApproved: true`, audited). Rejecting is for the owner or any head; the requester withdrawing their own request answers `cancelled`.',
  })
  @ApiOkResponse({ standardSchema: decidePromotionResultSchema })
  @ApiForbiddenResponse({ description: 'owner_only, reauth_required, or the database refused' })
  async decide(
    @Param({ schema: promotionParamSchema }) params: PromotionParam,
    @Body({ schema: decidePromotionSchema }) body: DecidePromotion,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.decidePromotion(
        uow,
        { type: 'user', id: principal.userId },
        principal.sessionId,
        principal.permissions.has('ai.autonomy.owner_approve'),
        params.promotionId,
        body,
      ),
    );
    return parseResponse(decidePromotionResultSchema, result);
  }

  @Post('promotions/:promotionId/apply')
  @HttpCode(200)
  @RequirePermission('ai.autonomy.owner_approve')
  @Audited({ action: AUDIT_ACTIONS.autonomyPromoted, targetType: 'intent' })
  @ApiOperation({
    summary: 'Move an approved intent to stage 3 (owner)',
    description:
      'Valid for 72 hours after the approval (`expired` after that). 409 `autosend_flag_off` when the instance does not run with AI_AUTOSEND_ENABLED. The database checks the whole chain again: an approved, unapplied promotion tied to a green report.',
  })
  @ApiOkResponse({ standardSchema: applyPromotionResultSchema })
  async apply(
    @Param({ schema: promotionParamSchema }) params: PromotionParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.applyPromotion(uow, { type: 'user', id: principal.userId }, params.promotionId),
    );
    return parseResponse(applyPromotionResultSchema, result);
  }

  @Get('disclosure')
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'The notice added to every automatic reply',
    description:
      'On by default (owner decision 3). `text.th` and `text.en` are appended to the reply in the customer language.',
  })
  @ApiOkResponse({ standardSchema: autosendDisclosureSchema })
  async disclosure() {
    return parseResponse(autosendDisclosureSchema, await this.autonomy.disclosure());
  }

  @Put('disclosure')
  @RequirePermission('ai.autonomy.set.any')
  @ApiOperation({
    summary: 'Change or turn off the notice of automatic replies (head)',
    description:
      'A reason is required; the audit entry keeps the old and the new value. The text is added on the server before the pre-send grade, so a change applies to the next reply.',
  })
  @ApiOkResponse({ standardSchema: autosendDisclosureSchema })
  async setDisclosure(
    @Body({ schema: setAutosendDisclosureSchema }) body: SetAutosendDisclosure,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await this.uow.run((uow) =>
      this.autonomy.setDisclosure(uow, { type: 'user', id: principal.userId }, body),
    );
    return parseResponse(autosendDisclosureSchema, result);
  }
}
