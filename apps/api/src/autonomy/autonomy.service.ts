import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import type {
  AutonomyHistoryEntry,
  AutonomyHistoryPage,
  AutonomyHistoryQuery,
  AutonomyState,
  IntentAutonomyChange,
  SetAiSwitch,
  SetAiSwitchResult,
  SetIntentAutonomy,
} from '@watchtower/shared';

import { and, desc, eq } from 'drizzle-orm';

import { notFound } from '../auth/http-errors.js';
import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';

/**
 * Autonomy stage per intent and the two global switches (T-112a, ADR-011). The rules live in
 * `@watchtower/domain`; this is the Nest face of it: it builds the context, hands the audit mark to
 * the request, and answers the domain's refusals with the api's HTTP errors.
 */
@Injectable()
export class AutonomyService {
  constructor(
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  read(): Promise<AutonomyState> {
    return this.domain.autonomy.read(this.database.db);
  }

  /**
   * Every stage and pin change of one intent, newest first, with who made it (T-127 H6). A read for
   * display, so it stays in the api (ADR-009); the rows are written only by `set_intent_autonomy()`.
   */
  async history(intentId: string, query: AutonomyHistoryQuery): Promise<AutonomyHistoryPage> {
    const { intent, intentAutonomyHistory: history, users } = schema;
    const [found] = await this.database.db
      .select({ id: intent.id })
      .from(intent)
      .where(eq(intent.id, intentId))
      .limit(1);
    if (found === undefined) throw notFound('No such intent');

    const rows = await this.database.db
      .select({
        row: history,
        userName: users.name,
        sortKey: preciseTimestamp(history.changedAt),
      })
      .from(history)
      .leftJoin(users, eq(users.id, history.changedBy))
      .where(
        and(
          eq(history.intentId, intentId),
          query.cursor === undefined
            ? undefined
            : beforeCursor(history.changedAt, history.id, decodeCursor(query.cursor)),
        ),
      )
      .orderBy(desc(history.changedAt), desc(history.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((entry) => ({ ...entry, id: entry.row.id })),
      query.limit,
    );
    return {
      items: page.rows.map(({ row, userName }): AutonomyHistoryEntry => ({
        id: row.id,
        intentId: row.intentId,
        change: row.change as AutonomyHistoryEntry['change'],
        fromStage: row.fromStage,
        toStage: row.toStage,
        pinned: row.pinned,
        reason: row.reason,
        changedBy: row.changedBy,
        changedByName: userName,
        changedAt: row.changedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async setSwitch(uow: UnitOfWork, actor: Actor, input: SetAiSwitch): Promise<SetAiSwitchResult> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.setSwitch(uow.tx, domainContext(this.domain, actor), input),
      ),
    );
  }

  async setIntent(
    uow: UnitOfWork,
    actor: Actor,
    intentId: string,
    input: SetIntentAutonomy,
  ): Promise<IntentAutonomyChange> {
    return translating(async () =>
      settle(
        uow,
        await this.domain.autonomy.setIntentStage(uow.tx, domainContext(this.domain, actor), {
          intentId,
          stage: input.stage,
          pinned: input.pinned,
          reason: input.reason,
        }),
      ),
    );
  }
}
