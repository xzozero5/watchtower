import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { evaluateBudget, readAiUsage, resolveAiCaps, utcDayStart } from '@watchtower/domain';
import type { AiBudget } from '@watchtower/shared';
import { desc, eq, sql } from 'drizzle-orm';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';

type Config = Pick<
  ApiConfig,
  | 'AI_DAILY_COST_CAP_USD'
  | 'AI_DAILY_TOKEN_CAP'
  | 'AI_BUDGET_ALERT_PERCENT'
  | 'ASSISTANT_USER_DAILY_TOKENS'
>;

/** How many assistant users the card lists. */
const TOP_USERS = 10;

/**
 * Today's AI spend against the caps (T-142). It reads the same numbers the AI guard reads
 * (`readAiUsage` / `evaluateBudget`), so the card can never disagree with the stop.
 */
@Injectable()
export class AiBudgetService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: Config,
  ) {}

  async read(now: Date = new Date()): Promise<AiBudget> {
    const db = this.database.db;
    const caps = resolveAiCaps(this.config);
    const status = evaluateBudget(caps, await readAiUsage(db, now));
    const day = now.toISOString().slice(0, 10);
    const usage = schema.assistantUsage;
    const rows = await db
      .select({
        userId: usage.userId,
        name: schema.users.name,
        tokens: sql<string>`(${usage.inputTokens} + ${usage.outputTokens})::text`,
        messages: usage.messages,
        costUsd: sql<string | null>`${usage.costUsd}::text`,
      })
      .from(usage)
      .innerJoin(schema.users, eq(schema.users.id, usage.userId))
      .where(eq(usage.day, day))
      .orderBy(desc(sql`${usage.inputTokens} + ${usage.outputTokens}`))
      .limit(TOP_USERS);
    return {
      day,
      resetsAt: new Date(utcDayStart(now).getTime() + 86_400_000).toISOString(),
      level: status.level,
      alertPercent: caps.alertPercent,
      cost: { spentUsd: status.usage.costUsd, capUsd: caps.dailyCostUsd },
      tokens: { spent: status.usage.tokens, cap: caps.dailyTokens },
      assistant: {
        userDailyTokens: this.config.ASSISTANT_USER_DAILY_TOKENS,
        users: rows.map((row) => ({
          userId: row.userId,
          name: row.name,
          tokens: Number(row.tokens),
          messages: row.messages,
          costUsd: row.costUsd === null ? null : Number(row.costUsd),
        })),
      },
    };
  }
}
