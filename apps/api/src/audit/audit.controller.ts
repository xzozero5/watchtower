import { Controller, Get, Header, Inject, Query, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  auditLogExportQuerySchema,
  auditLogPageSchema,
  auditLogQuerySchema,
  type AuditLogExportQuery,
  type AuditLogQuery,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AuditScope } from './audit-scope.js';
import { auditCsv } from './audit-csv.js';
import { AuditService } from './audit.service.js';

/** Exports per head per hour `[ASSUMED]`: an export is for an auditor or a review, not for polling. */
const EXPORT_LIMIT = 6;
const EXPORT_WINDOW_SECONDS = 3600;

@ApiTags('audit')
@Controller('v1/audit-logs')
export class AuditController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get()
  @RequirePermission('audit.read')
  // Reading the log is itself a read of personal data (actors, IPs); it is on the log too.
  @Audited({ action: 'audit.log.read', targetType: 'audit_log', always: true })
  @ApiOperation({
    summary: 'Search the audit log',
    description:
      'Newest first, keyset-paginated: pass `nextCursor` back as `cursor`. The log is append-only; ' +
      'before/after never contain secrets, tokens or password hashes. Requires `audit.read` (head).',
  })
  @ApiOkResponse({ standardSchema: auditLogPageSchema })
  async search(@Query({ schema: auditLogQuerySchema }) query: AuditLogQuery) {
    return parseResponse(auditLogPageSchema, await this.audit.list(query));
  }

  @Get('export')
  // Export is the head's: `audit.read` (head by default, locked to the head role) and the export
  // permission the PRD names for taking data out (section 8.2: "export requires head").
  @RequirePermission('audit.read', 'pii.export')
  @Audited({ action: AUDIT_ACTIONS.auditLogExport, targetType: 'audit_log', always: true })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Export the audit log as CSV (head)',
    description:
      'Same filters as the search (`actorType`, `actorId`, `action`, `outcome`, `targetType`, ' +
      '`targetId`, `from`, `to`), newest first, at most `maxRows` rows (default and ceiling 50 000; ' +
      'narrow the dates for more). Columns: id, createdAt, actorType, actorId, action, outcome, ' +
      'targetType, targetId, requestId. No IP address, no before/after and no metadata. Cells ' +
      'that a spreadsheet could run as a formula are defused. Limited to 6 exports per hour per ' +
      'person; every export (and every refused one) is on the audit log with its filters and row count.',
  })
  @ApiOkResponse({
    description: 'CSV, one header row then one row per entry',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @ApiTooManyRequestsResponse({ description: 'Too many exports; see Retry-After' })
  async export(
    @Query({ schema: auditLogExportQuerySchema }) query: AuditLogExportQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    const { maxRows, ...filters } = query;
    AuditScope.set({ metadata: { filters, maxRows } });
    await this.limiter.enforce(
      'audit-export',
      principal.userId,
      EXPORT_LIMIT,
      EXPORT_WINDOW_SECONDS,
    );
    const rows = await this.audit.exportRows(filters, maxRows);
    AuditScope.set({ metadata: { rowCount: rows.length, truncated: rows.length >= maxRows } });
    return new StreamableFile(Buffer.from(auditCsv(rows), 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }
}
