import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type {
  CsatResponseItem,
  CsatResponsesPage,
  CsatResponsesQuery,
  CsatSummary,
  CsatSummaryQuery,
} from '@watchtower/shared';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';

import { beforeCursor, decodeCursor, preciseTimestamp, toPage } from '../common/keyset.js';
import { DATABASE } from '../database/database.module.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 30;

interface Bucket {
  readonly count: number;
  readonly average: number | null;
}

const toBucket = (count: number, average: string | null): Bucket => ({
  count,
  average: average === null ? null : Math.round(Number(average) * 100) / 100,
});

/**
 * Reads CSAT results for staff (R-10.5): the answers one by one, and the metrics (overall, per
 * agent, per intent, AI-handled against human). Read only; the caller needs `csat.read`. The
 * period is by answer time and defaults to the last 30 days.
 */
@Injectable()
export class CsatReader {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  async responses(query: CsatResponsesQuery): Promise<CsatResponsesPage> {
    const survey = schema.csatSurvey;
    const conditions: (SQL | undefined)[] = [
      eq(survey.status, 'answered'),
      query.from === undefined ? undefined : gte(survey.answeredAt, new Date(query.from)),
      query.to === undefined ? undefined : lte(survey.answeredAt, new Date(query.to)),
      query.maxScore === undefined ? undefined : lte(survey.score, query.maxScore),
      query.cursor === undefined
        ? undefined
        : beforeCursor(survey.answeredAt, survey.id, decodeCursor(query.cursor)),
    ];
    const rows = await this.database.db
      .select({
        survey,
        number: schema.ticket.number,
        aiHandled: schema.ticket.aiHandled,
        assigneeId: schema.ticket.assigneeId,
        intentId: schema.ticket.intentId,
        sortKey: preciseTimestamp(survey.answeredAt),
      })
      .from(survey)
      .innerJoin(schema.ticket, eq(schema.ticket.id, survey.ticketId))
      .where(and(...conditions))
      .orderBy(desc(survey.answeredAt), desc(survey.id))
      .limit(query.limit + 1);
    const page = toPage(
      rows.map((row) => ({ ...row, id: row.survey.id })),
      query.limit,
    );
    return {
      items: page.rows.flatMap(({ survey: row, number, aiHandled, assigneeId, intentId }) =>
        row.score === null || row.answeredAt === null
          ? []
          : [
              {
                id: row.id,
                ticketId: row.ticketId,
                ticketKey: this.keys.format(number),
                score: row.score,
                resolved: row.resolved,
                comment: row.comment,
                reopened: row.reopened,
                aiHandled,
                assigneeId,
                intentId,
                answeredAt: row.answeredAt.toISOString(),
              } satisfies CsatResponseItem,
            ],
      ),
      nextCursor: page.nextCursor,
    };
  }

  async summary(query: CsatSummaryQuery): Promise<CsatSummary> {
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const from =
      query.from === undefined
        ? new Date(to.getTime() - DEFAULT_PERIOD_DAYS * DAY_MS)
        : new Date(query.from);
    const survey = schema.csatSurvey;
    const answered = and(
      eq(survey.status, 'answered'),
      gte(survey.answeredAt, from),
      lte(survey.answeredAt, to),
    );
    const db = this.database.db;

    const [sent] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(survey)
      .where(and(gte(survey.sentAt, from), lte(survey.sentAt, to)));

    const byScore = await db
      .select({ score: survey.score, count: sql<number>`count(*)::int` })
      .from(survey)
      .where(answered)
      .groupBy(survey.score);
    const distribution = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
    let responses = 0;
    let total = 0;
    for (const row of byScore) {
      if (row.score === null) continue;
      distribution[String(row.score) as keyof typeof distribution] = row.count;
      responses += row.count;
      total += row.score * row.count;
    }

    const [reopened] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(survey)
      .where(and(answered, eq(survey.reopened, true)));

    const average = sql<string | null>`round(avg(${survey.score})::numeric, 4)::text`;
    const count = sql<number>`count(*)::int`;
    const ticket = schema.ticket;
    const byHandler = await db
      .select({ aiHandled: ticket.aiHandled, count, average })
      .from(survey)
      .innerJoin(ticket, eq(ticket.id, survey.ticketId))
      .where(answered)
      .groupBy(ticket.aiHandled);
    const handler = (ai: boolean): Bucket => {
      const row = byHandler.find((entry) => entry.aiHandled === ai);
      return row ? toBucket(row.count, row.average) : { count: 0, average: null };
    };

    const byAgent = await db
      .select({ assigneeId: ticket.assigneeId, name: schema.users.name, count, average })
      .from(survey)
      .innerJoin(ticket, eq(ticket.id, survey.ticketId))
      .leftJoin(schema.users, eq(schema.users.id, ticket.assigneeId))
      .where(answered)
      .groupBy(ticket.assigneeId, schema.users.name)
      .orderBy(desc(count));
    const byIntent = await db
      .select({ intentId: ticket.intentId, name: schema.intent.name, count, average })
      .from(survey)
      .innerJoin(ticket, eq(ticket.id, survey.ticketId))
      .leftJoin(schema.intent, eq(schema.intent.id, ticket.intentId))
      .where(answered)
      .groupBy(ticket.intentId, schema.intent.name)
      .orderBy(desc(count));

    const sentCount = sent?.count ?? 0;
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      surveysSent: sentCount,
      responses,
      responseRate: sentCount === 0 ? null : Math.round((responses / sentCount) * 1000) / 1000,
      average: responses === 0 ? null : Math.round((total / responses) * 100) / 100,
      reopened: reopened?.count ?? 0,
      distribution,
      aiHandled: handler(true),
      human: handler(false),
      byAgent: byAgent.map((row) => ({
        assigneeId: row.assigneeId,
        name: row.name,
        ...toBucket(row.count, row.average),
      })),
      byIntent: byIntent.map((row) => ({
        intentId: row.intentId,
        name: row.name,
        ...toBucket(row.count, row.average),
      })),
    };
  }
}
