import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { aiEvidenceSchema, type AiState, type TicketAiInsight } from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { TicketReader } from '../tickets/ticket-reader.js';

type InsightRow = typeof schema.aiTicketInsight.$inferSelect;

/** Row to contract. Absent pieces stay absent: the web shows what exists and nothing else (N5). */
export function toTicketAiInsight(row: InsightRow): TicketAiInsight {
  const evidence = z.array(aiEvidenceSchema).safeParse(row.evidence);
  return {
    state: row.state as AiState,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.intentKey === null || row.intentConfidence === null
      ? {}
      : {
          intent: {
            key: row.intentKey,
            confidence: row.intentConfidence,
            reason: row.intentReason ?? '',
          },
        }),
    ...(row.nextStepKind === null
      ? {}
      : {
          nextStep: {
            kind: row.nextStepKind as NonNullable<TicketAiInsight['nextStep']>['kind'],
            label: row.nextStepLabel ?? '',
          },
        }),
    evidence: evidence.success ? evidence.data : [],
    stage: row.stage,
    generatedAt: row.generatedAt.toISOString(),
  };
}

@Injectable()
export class TicketAiService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly tickets: TicketReader,
  ) {}

  /**
   * The AI brief of a ticket the principal may read (404 otherwise, like the ticket itself), or 404
   * when the AI has not made one. Staff only: the controller refuses a client before this runs.
   */
  async insightOf(
    ref: string,
    principal: Principal,
  ): Promise<{ ticketId: string; insight: TicketAiInsight }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    const [row] = await this.database.db
      .select()
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticket.t.id))
      .limit(1);
    if (row === undefined) throw notFound('No AI brief for this ticket');
    return { ticketId: ticket.t.id, insight: toTicketAiInsight(row) };
  }
}
