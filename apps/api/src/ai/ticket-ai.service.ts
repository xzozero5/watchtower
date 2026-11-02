import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { Actor } from '@watchtower/domain';
import {
  AI_JOBS,
  AI_OUTBOX_JOB_OPTIONS,
  AI_REQUEST_LIMITS,
  QUEUE_NAMES,
  aiEvidenceSchema,
  aiProgressSchema,
  aiReportSchema,
  type AiDraft,
  type Claim,
  type AiRequest,
  type AiState,
  type RejectAiDraft,
  type TicketAiInsight,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { conflict, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import type { UnitOfWork } from '../realtime/unit-of-work.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { claimsOfReport, ticketKeyOfHref } from './insight-claims.js';

type InsightRow = typeof schema.aiTicketInsight.$inferSelect;
type DraftRow = typeof schema.aiDraft.$inferSelect;

/** A request for a draft or a new investigation is refused while one is already running. [ASSUMED] */
const REQUEST_COOLDOWN_MS = 2 * 60_000;

/** The draft a person may act on: the one still waiting, in the contract's shape. */
export function toAiDraft(row: DraftRow): AiDraft {
  return {
    id: row.id,
    body: row.bodyText,
    citations: [...new Set(row.citations.map((citation) => citation.evidenceId))],
    uncitedClaims: row.uncitedClaims,
    promptVersion: row.promptVersion === null ? 'unknown' : `v${String(row.promptVersion)}`,
    createdAt: row.createdAt.toISOString(),
    ...(row.language === null ? {} : { language: row.language }),
    ...(row.needsReview ? { needsReview: true } : {}),
    ...(row.disclosureLevel === 'verified' || row.disclosureLevel === 'restricted'
      ? {
          disclosure: {
            level: row.disclosureLevel,
            removedSentences: row.disclosureRemoved,
          },
        }
      : {}),
  };
}

/** What the row alone does not hold: the name of the intent and the report's findings as claims (T-135). */
export interface InsightExtras {
  readonly intentName?: string | null;
  readonly claims?: Claim[];
}

/**
 * Row to contract. Absent pieces stay absent: the web shows what exists and nothing else (N5). A
 * `draft_ready` brief whose draft is no longer waiting (approved, sent, replaced) reads as
 * `classified`, so the web never offers to approve what a person already used.
 */
export function toTicketAiInsight(
  row: InsightRow,
  draft?: DraftRow,
  extras: InsightExtras = {},
): TicketAiInsight {
  const evidence = z.array(aiEvidenceSchema).safeParse(row.evidence);
  const report = aiReportSchema.safeParse(row.report);
  const progress = aiProgressSchema.safeParse(row.progress);
  const waiting = draft?.status === 'draft' ? draft : undefined;
  const state: AiState =
    row.state === 'draft_ready' && waiting === undefined ? 'classified' : (row.state as AiState);
  return {
    state,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.intentKey === null || row.intentConfidence === null
      ? {}
      : {
          intent: {
            key: row.intentKey,
            ...(extras.intentName === undefined || extras.intentName === null
              ? {}
              : { name: extras.intentName }),
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
    ...(waiting === undefined ? {} : { draft: toAiDraft(waiting) }),
    ...(report.success
      ? {
          report: {
            ...report.data,
            ...(extras.claims === undefined ? {} : { claims: extras.claims }),
          },
        }
      : {}),
    ...(progress.success && state === 'investigating' ? { progress: progress.data } : {}),
    stage: row.stage,
    generatedAt: row.generatedAt.toISOString(),
  };
}

@Injectable()
export class TicketAiService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly tickets: TicketReader,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
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
    const draft =
      row.draftId === null
        ? undefined
        : (
            await this.database.db
              .select()
              .from(schema.aiDraft)
              .where(eq(schema.aiDraft.id, row.draftId))
              .limit(1)
          )[0];
    // The name of the intent, and the report as claims whose links this viewer may open (T-135).
    const [intent] =
      row.intentKey === null
        ? []
        : await this.database.db
            .select({ name: schema.intent.name })
            .from(schema.intent)
            .where(eq(schema.intent.key, row.intentKey))
            .limit(1);
    const report = aiReportSchema.safeParse(row.report);
    const cards = z.array(aiEvidenceSchema).safeParse(row.evidence);
    let claims: Claim[] | undefined;
    if (report.success) {
      const evidence = cards.success ? cards.data : [];
      const open = new Set<string>();
      for (const key of new Set(evidence.map((card) => ticketKeyOfHref(card.href)))) {
        if (key === null) continue;
        try {
          await this.tickets.viewRow(key, principal);
          open.add(key);
        } catch {
          // A ticket this viewer cannot read gets no link.
        }
      }
      claims = claimsOfReport(report.data, evidence, open);
    }
    return {
      ticketId: ticket.t.id,
      insight: toTicketAiInsight(row, draft, {
        intentName: intent?.name ?? null,
        ...(claims === undefined ? {} : { claims }),
      }),
    };
  }

  /**
   * A person rejects the draft with one of nine reason codes (UI spec section 6.3). 404 for a ticket
   * or draft they cannot see, 409 when the draft was already used. The reason goes to the learning
   * loop; it is never fed back to a model as an instruction.
   */
  async rejectDraft(
    uow: UnitOfWork,
    ref: string,
    draftId: string,
    body: RejectAiDraft,
    principal: Principal,
    actor: Actor,
  ): Promise<{ ticketId: string; draftId: string }> {
    // Same visibility rule as the brief: a ticket the principal cannot read is a 404.
    const ticket = await this.tickets.viewRow(ref, principal);
    const result = await translating(async () =>
      settle(
        uow,
        await this.domain.ai.rejectDraft(uow.tx, domainContext(this.domain, actor), {
          ref: ticket.t.id,
          draftId,
          rejection: body,
        }),
      ),
    );
    return { ticketId: ticket.t.id, draftId: result.draftId };
  }

  /**
   * "Draft a reply" at stage 1, or investigate again: queues the job and shows it as running at once.
   * Refused (409) while a job for the ticket was queued in the last two minutes, so a double click
   * is one job. The job id is new each time; the budget of the tools is what bounds the repeats.
   */
  async request(
    uow: UnitOfWork,
    ref: string,
    body: AiRequest,
    principal: Principal,
  ): Promise<{ ticketId: string }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    const ticketId = ticket.t.id;
    if (body.kind === 'draft') {
      // The gate refuses to send a draft at stage 0, or for a ticket with no intent: do not write one.
      const [intent] =
        ticket.t.intentId === null
          ? []
          : await uow.tx
              .select({ stage: schema.intent.autonomyStage })
              .from(schema.intent)
              .where(eq(schema.intent.id, ticket.t.intentId))
              .limit(1);
      if (intent === undefined)
        throw conflict('Set the intent of the ticket before asking for a draft');
      if (intent.stage < 1) throw conflict('Drafts are off for this intent (stage 0)');
    }
    const [row] = await uow.tx
      .select({
        state: schema.aiTicketInsight.state,
        progress: schema.aiTicketInsight.progress,
        updatedAt: schema.aiTicketInsight.updatedAt,
      })
      .from(schema.aiTicketInsight)
      .where(eq(schema.aiTicketInsight.ticketId, ticketId))
      .for('update');
    const now = Date.now();
    if (
      row?.state === 'investigating' &&
      row.progress !== null &&
      now - row.updatedAt.getTime() < REQUEST_COOLDOWN_MS
    ) {
      throw conflict('The AI is already working on this ticket');
    }
    // Per ticket and hour, whoever asks, from a counter (Redis): a draft on request makes a model call
    // with no tool call, so the tool budget does not bound it, and the outbox row that carried the
    // request is cleared once it is relayed, so it cannot be counted afterwards.
    await this.limiter.enforce(
      'ai-request-ticket',
      ticketId,
      AI_REQUEST_LIMITS.perTicketPerHour,
      3600,
    );
    const stamp = new Date(now);
    await uow.tx
      .insert(schema.aiTicketInsight)
      .values({
        ticketId,
        state: 'investigating',
        progress: { phase: 'queued', step: 0, steps: 1 },
        requestedBy: principal.userId,
        generatedAt: stamp,
      })
      .onConflictDoUpdate({
        target: schema.aiTicketInsight.ticketId,
        set: {
          state: 'investigating',
          progress: { phase: 'queued', step: 0, steps: 1 },
          requestedBy: principal.userId,
          updatedAt: stamp,
        },
      });
    const job = body.kind === 'draft' ? AI_JOBS.draft : AI_JOBS.investigate;
    await this.domain.outbox.enqueue(uow.tx, this.domain.config, {
      queue: QUEUE_NAMES.ai,
      name: job,
      jobId: `ai-${body.kind}-${ticketId}-${String(now)}`,
      payload: {
        ticketId,
        requestedBy: principal.userId,
        ...(body.kind === 'draft' && body.note !== undefined ? { note: body.note } : {}),
      },
      options: AI_OUTBOX_JOB_OPTIONS,
    });
    return { ticketId };
  }
}
