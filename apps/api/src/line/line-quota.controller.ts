import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { line } from '@watchtower/channels';
import { schema, type Database } from '@watchtower/db';
import { lineQuotaSchema, type LineQuota } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DATABASE } from '../database/database.module.js';

/**
 * How much of the monthly push allowance each LINE Official Account has used (R-2.10): the number
 * the composer shows next to the send button, with the warning from 80%. Read-only; the dispatcher
 * moves the counter and the worker reconciles it hourly with LINE's own figures.
 */
@ApiTags('line')
@Controller('v1/line')
export class LineQuotaController {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  @Get('quota')
  @RequirePermission('ticket.reply')
  @ApiOperation({
    summary: 'LINE push quota used this month, per account',
    description:
      'Reply-token messages are free and not counted. `level` is `warn` from 80% used and ' +
      '`exhausted` when no push fits: the composer then suggests email (PRD section 8.3). `limit` ' +
      'is the plan allowance until the hourly reconcile learns the real one.',
  })
  @ApiOkResponse({ standardSchema: lineQuotaSchema })
  async quota() {
    const period = line.quotaPeriod(new Date());
    const accounts = await this.database.db
      .select({
        id: schema.channelAccount.id,
        name: schema.channelAccount.name,
      })
      .from(schema.channelAccount)
      .where(eq(schema.channelAccount.type, 'line'));
    const usage = await this.database.db
      .select()
      .from(schema.channelQuotaUsage)
      .where(eq(schema.channelQuotaUsage.period, period));
    const result: LineQuota = {
      accounts: accounts.map((account) => {
        const row = usage.find((candidate) => candidate.channelAccountId === account.id);
        // No push yet this month: nothing used, against the free allowance the counter starts from.
        const view = line.evaluateQuota({
          used: row?.used ?? 0,
          limit: row === undefined ? line.FALLBACK_QUOTA_LIMIT : row.quotaLimit,
        });
        return {
          channelAccountId: account.id,
          name: account.name,
          period,
          used: view.used,
          limit: view.limit,
          remaining: view.remaining,
          percentUsed: view.percentUsed,
          level: view.level,
          reconciledAt: row?.reconciledAt?.toISOString() ?? null,
        };
      }),
    };
    return parseResponse(lineQuotaSchema, result);
  }
}
