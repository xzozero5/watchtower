import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  REPORTS_AUDIT_ACTIONS,
  aiCostQuerySchema,
  aiCostSchema,
  ceoExportQuerySchema,
  ceoImportBodySchema,
  ceoImportResultSchema,
  ceoMetricKeyParamSchema,
  ceoPointsBodySchema,
  ceoQuerySchema,
  ceoViewSchema,
  type AiCostQuery,
  type CeoExportQuery,
  type CeoImportBody,
  type CeoMetricKeyParam,
  type CeoPointsBody,
  type CeoQuery,
} from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { badRequest } from '../auth/http-errors.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AiCostService } from './ai-cost.service.js';
import { ceoCsv, ceoHtml, CeoCsvError, parseCeoPointsCsv } from './ceo-files.js';
import { CeoViewService } from './ceo-view.service.js';

/** Reports for heads and leads: the AI cost dashboard (T-305a) and the CEO view (T-305b). */
@ApiTags('reports')
@Controller('v1/reports')
export class ReportsController {
  constructor(
    @Inject(AiCostService) private readonly cost: AiCostService,
    @Inject(CeoViewService) private readonly ceo: CeoViewService,
  ) {}

  @Get('ai-cost')
  @RequirePermission('ai.run.read')
  @ApiOperation({
    summary: 'AI cost and tokens per agent, intent, ticket and day (lead and up)',
    description:
      'Over the last `days` whole UTC days (today included) from `ai_run`, with totals for the same number ' +
      'of days right before. `top` caps the per-intent and per-ticket lists (the rest of the intents are ' +
      'summed in `byIntentOthers`). Calls nobody priced (the mock provider, a model without a price) are ' +
      'counted in `unpricedRuns` and add nothing to `costUsd`. Today against the caps is `GET /v1/ai/budget`.',
  })
  @ApiOkResponse({ standardSchema: aiCostSchema })
  @ApiForbiddenResponse({ description: 'Needs `ai.run.read`' })
  async aiCost(
    @Query({ schema: aiCostQuerySchema }) query: AiCostQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(aiCostSchema, await this.cost.read(query.days, query.top, principal));
  }

  @Get('ceo')
  @RequirePermission('ceo.view')
  @ApiOperation({
    summary:
      'CEO view: KPI tiles with the period before, savings formula, pluggable tiles (lead and up)',
    description:
      'Volume, first response and resolution (median), SLA compliance, CSAT, AI-assisted share, ' +
      'verified-resolution rate and automation savings over the last `days` whole UTC days, each next to ' +
      'the same number of days before. A KPI with nothing behind it is `not_available`, never a zero. ' +
      'Tickets of a seed batch are not counted. The savings formula is an assumption and is returned in ' +
      '`formula`. `externalTiles` are numbers fed by the API or a CSV import (newest point and the one before).',
  })
  @ApiOkResponse({ standardSchema: ceoViewSchema })
  @ApiForbiddenResponse({ description: 'Needs `ceo.view`' })
  async ceoView(
    @Query({ schema: ceoQuerySchema }) query: CeoQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(ceoViewSchema, await this.ceo.read(query.days, principal));
  }

  @Get('ceo/export')
  @RequirePermission('ceo.view')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.ceoExport, targetType: 'report', always: true })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Export the CEO view as CSV or a self-contained HTML page (lead and up)',
    description:
      'Same figures as `GET /v1/reports/ceo`. CSV cells a spreadsheet could run as a formula are defused. ' +
      'HTML has no script and makes no outside request. PDF is a later task. Every export is audited.',
  })
  @ApiOkResponse({
    description: 'CSV or HTML',
    content: {
      'text/csv': { schema: { type: 'string' } },
      'text/html': { schema: { type: 'string' } },
    },
  })
  async export(
    @Query({ schema: ceoExportQuerySchema }) query: CeoExportQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    AuditScope.set({ metadata: { format: query.format, days: query.days } });
    const view = parseResponse(ceoViewSchema, await this.ceo.read(query.days, principal));
    const day = view.generatedAt.slice(0, 10);
    const csv = query.format === 'csv';
    return new StreamableFile(Buffer.from(csv ? ceoCsv(view) : ceoHtml(view), 'utf8'), {
      type: csv ? 'text/csv; charset=utf-8' : 'text/html; charset=utf-8',
      disposition: `attachment; filename="ceo-view-${day}.${query.format}"`,
    });
  }

  @Post('ceo/points')
  @RequirePermission('metric.manage')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.ceoPointRecord, targetType: 'ceo_tile' })
  @ApiOperation({
    summary: 'Record data points of pluggable CEO tiles (head)',
    description:
      'Numbers the system does not compute (platform uptime from monitoring, revenue, churn). A tile exists ' +
      'once it has a point; a repeat of the same `key` and `observedAt` replaces the value. The tile shows ' +
      'the newest point and the one before it.',
  })
  @ApiCreatedResponse({ standardSchema: ceoImportResultSchema })
  @ApiBadRequestResponse({ description: 'Invalid body' })
  async record(
    @Body({ schema: ceoPointsBodySchema }) body: CeoPointsBody,
    @CurrentPrincipal() principal: Principal,
  ) {
    const keys = [...new Set(body.points.map((point) => point.key))];
    AuditScope.set({ metadata: { keys: keys.slice(0, 20), points: body.points.length } });
    const imported = await this.ceo.recordPoints(body.points, 'api', principal.userId);
    return parseResponse(ceoImportResultSchema, { imported });
  }

  @Post('ceo/points/import')
  @RequirePermission('metric.manage')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.ceoPointImport, targetType: 'ceo_tile' })
  @ApiOperation({
    summary: 'Import data points of pluggable CEO tiles from CSV (head)',
    description:
      'The CSV header is `key,label,unit,higher_is_better,value,observed_at`. All or nothing: the first bad ' +
      'row answers 400 with its line number and nothing is stored.',
  })
  @ApiCreatedResponse({ standardSchema: ceoImportResultSchema })
  @ApiBadRequestResponse({ description: 'Unreadable CSV, with the line that failed' })
  async importCsv(
    @Body({ schema: ceoImportBodySchema }) body: CeoImportBody,
    @CurrentPrincipal() principal: Principal,
  ) {
    let points;
    try {
      points = parseCeoPointsCsv(body.csv);
    } catch (error) {
      if (error instanceof CeoCsvError) throw badRequest(error.message);
      throw error;
    }
    if (points.length === 0) throw badRequest('the CSV has a header and no rows');
    if (points.length > 500) throw badRequest('at most 500 rows in one import');
    AuditScope.set({ metadata: { points: points.length } });
    const imported = await this.ceo.recordPoints(points, 'csv', principal.userId);
    return parseResponse(ceoImportResultSchema, { imported });
  }

  @Delete('ceo/metrics/:key')
  @HttpCode(204)
  @RequirePermission('metric.manage')
  @Audited({ action: REPORTS_AUDIT_ACTIONS.ceoMetricDelete, targetType: 'ceo_tile' })
  @ApiOperation({ summary: 'Remove a pluggable CEO tile and all its points (head)' })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'No such tile' })
  async remove(@Param({ schema: ceoMetricKeyParamSchema }) params: CeoMetricKeyParam) {
    AuditScope.set({ targetId: params.key });
    await this.ceo.deleteMetric(params.key);
  }
}
