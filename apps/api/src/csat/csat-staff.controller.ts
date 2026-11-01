import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  csatOptOutParamSchema,
  csatOptOutResultSchema,
  csatOptOutSchema,
  csatResponsesPageSchema,
  csatResponsesQuerySchema,
  csatSettingsSchema,
  csatSummaryQuerySchema,
  csatSummarySchema,
  type CsatOptOut,
  type CsatResponsesQuery,
  type CsatSettings,
  type CsatSummaryQuery,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  AuditPiiRead,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';
import { CsatReader } from './csat-reader.service.js';

type OptOutParam = z.infer<typeof csatOptOutParamSchema>;

/**
 * Staff side of CSAT (R-10.5): results and metrics (`csat.read`), the survey delay (head) and the
 * per-organization opt-out (`org.manage`, R-10.4). Reads are read-only; the two writes are audited
 * with the old and new value.
 */
@ApiTags('csat')
@Controller('v1/csat')
export class CsatStaffController {
  constructor(
    @Inject(CsatReader) private readonly reader: CsatReader,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
  ) {}

  @Get('responses')
  @RequirePermission('csat.read')
  @AuditPiiRead('csat_survey')
  @ApiOperation({
    summary: 'CSAT answers, newest first',
    description:
      'Score, "was this resolved?", the customer comment (customer text: the read is audited), ' +
      'whether the answer reopened the ticket, and the ticket facts that metrics group by. ' +
      'Filter by period and by `maxScore` to see the unhappy ones.',
  })
  @ApiOkResponse({ standardSchema: csatResponsesPageSchema })
  async responses(@Query({ schema: csatResponsesQuerySchema }) query: CsatResponsesQuery) {
    return parseResponse(csatResponsesPageSchema, await this.reader.responses(query));
  }

  @Get('summary')
  @RequirePermission('csat.read')
  @ApiOperation({
    summary: 'CSAT metrics for a period',
    description:
      'Overall average and distribution, response rate, reopened count, AI-handled against human, ' +
      'per agent and per intent. Period by answer time, default the last 30 days.',
  })
  @ApiOkResponse({ standardSchema: csatSummarySchema })
  async summary(@Query({ schema: csatSummaryQuerySchema }) query: CsatSummaryQuery) {
    return parseResponse(csatSummarySchema, await this.reader.summary(query));
  }

  @Get('settings')
  @RequirePermission('csat.read')
  @ApiOperation({ summary: 'CSAT settings of this instance' })
  @ApiOkResponse({ standardSchema: csatSettingsSchema })
  async readSettings() {
    const delayMinutes = await this.domain.csat.readDelayMinutes(this.database.db);
    return parseResponse(csatSettingsSchema, { delayMinutes });
  }

  @Put('settings')
  @RequirePermission('integration.manage')
  @Audited({ action: AUDIT_ACTIONS.csatSettingSet, targetType: 'instance_setting' })
  @ApiOperation({
    summary: 'Change the CSAT settings (head)',
    description:
      '`delayMinutes` (0-10080, default 60) is how long after "resolved" the survey is sent. ' +
      'Applies to surveys scheduled after the change.',
  })
  @ApiOkResponse({ standardSchema: csatSettingsSchema })
  async writeSettings(
    @Body({ schema: csatSettingsSchema }) body: CsatSettings,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.csat.setDelayMinutes(
            uow.tx,
            domainContext(this.domain, { type: 'user', id: principal.userId }),
            body.delayMinutes,
          ),
        ),
      ),
    );
    return parseResponse(csatSettingsSchema, result);
  }

  @Put('opt-outs/:orgId')
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.csatOptOutSet, targetType: 'organization' })
  @ApiOperation({
    summary: 'Opt an organization out of (or back into) CSAT surveys',
    description:
      'An organization that opted out is never surveyed (R-10.4); surveys already scheduled for it ' +
      'are skipped when they come due.',
  })
  @ApiOkResponse({ standardSchema: csatOptOutResultSchema })
  async setOptOut(
    @Param({ schema: csatOptOutParamSchema }) params: OptOutParam,
    @Body({ schema: csatOptOutSchema }) body: CsatOptOut,
    @CurrentPrincipal() principal: Principal,
  ) {
    const result = await translating(() =>
      this.uow.run(async (uow) =>
        settle(
          uow,
          await this.domain.csat.setOptOut(
            uow.tx,
            domainContext(this.domain, { type: 'user', id: principal.userId }),
            params.orgId,
            body.optedOut,
          ),
        ),
      ),
    );
    return parseResponse(csatOptOutResultSchema, result);
  }
}
