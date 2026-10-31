import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { auditLogPageSchema, auditLogQuerySchema, type AuditLogQuery } from '@watchtower/shared';

import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { AuditService } from './audit.service.js';

@ApiTags('audit')
@Controller('v1/audit-logs')
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

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
}
