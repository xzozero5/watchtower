import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { runAssistantTurn } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { evaluateBudget, readAiUsage, readSwitchState, resolveAiCaps } from '@watchtower/domain';
import {
  ASSISTANT_LIMITS,
  AUDIT_ACTIONS,
  makeClaim,
  type AssistantLocale,
  type AssistantMessageRequest,
  type AssistantReply,
  type AssistantStarters,
  type AssistantStartersQuery,
  type AssistantState,
  type AssistantToolRun,
  type Claim,
  type ProposalCard,
} from '@watchtower/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { AI_RUNTIME, type AiRuntime } from '../ai/ai-runtime.js';
import { AuditScope } from '../audit/audit-scope.js';
import { notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { KbService } from '../kb/kb.service.js';
import { BriefService } from '../shifts/brief.service.js';
import { SlaRemaining } from '../tickets/sla-remaining.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader } from '../tickets/ticket-reader.js';
import { ToolRunner } from '../tools/tool-runner.service.js';
import { isMasked, proposalKindsFor, startersFor } from './assistant-access.js';
import { AssistantProposals } from './assistant-proposals.js';
import { buildAssistantTools } from './assistant-tools.js';
import { NOTES } from './assistant-text.js';

type Config = Pick<
  ApiConfig,
  | 'AI_PROVIDER'
  | 'AI_DAILY_COST_CAP_USD'
  | 'AI_DAILY_TOKEN_CAP'
  | 'AI_BUDGET_ALERT_PERCENT'
  | 'ASSISTANT_MESSAGES_PER_HOUR'
  | 'ASSISTANT_USER_DAILY_TOKENS'
  | 'EMBEDDING_PROVIDER'
>;

const THAI = /[฀-๿]/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Thai in the text means a Thai screen when the web did not say. */
export function localeOf(requested: AssistantLocale | undefined, text: string): AssistantLocale {
  return requested ?? (THAI.test(text) ? 'th' : 'en');
}

interface Standing {
  readonly state: AssistantState;
  readonly reason: string | null;
}

/**
 * The assistant (T-134, ADR-017). One message is: checks that need no model (rate, the person's
 * budget, the system's state), then two audited model calls around the tools the person's role and
 * permissions allow, then the cards for what the person asked to change. It stores only redacted
 * text. It cannot write anything: the writes are in `AssistantProposals` and wait for a press.
 */
@Injectable()
export class AssistantService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(AI_RUNTIME) private readonly runtime: AiRuntime,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(SlaRemaining) private readonly sla: SlaRemaining,
    @Inject(KbService) private readonly kb: KbService,
    @Inject(BriefService) private readonly brief: BriefService,
    @Inject(ToolRunner) private readonly runner: ToolRunner,
    @Inject(AssistantProposals) private readonly proposals: AssistantProposals,
  ) {}

  // --- state ------------------------------------------------------------------------------------

  /**
   * Whether the assistant can answer now, without a model call and without the side effects of the
   * guard (it writes an audit row for every denial; a screen asking for its state must not).
   */
  private async standing(userId: string): Promise<Standing> {
    if (!this.runtime.ready) {
      return {
        state: 'unavailable',
        reason: this.runtime.notReadyReason ?? 'provider_unavailable',
      };
    }
    const db = this.database.db;
    const switches = await readSwitchState(db);
    if (switches.killSwitch) return { state: 'paused', reason: 'kill_switch_on' };
    const now = new Date();
    const status = evaluateBudget(resolveAiCaps(this.config), await readAiUsage(db, now));
    if (status.level === 'stop') return { state: 'budget', reason: 'budget_stop' };
    if ((await this.tokensToday(userId, now)) >= this.config.ASSISTANT_USER_DAILY_TOKENS) {
      return { state: 'budget', reason: 'user_budget' };
    }
    return { state: 'ok', reason: null };
  }

  private async tokensToday(userId: string, now: Date): Promise<number> {
    const start = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
    const [row] = await this.database.db
      .select({
        tokens: sql<string>`coalesce(sum(${schema.assistantMessage.inputTokens} + ${schema.assistantMessage.outputTokens}), 0)`,
      })
      .from(schema.assistantMessage)
      .where(
        and(
          eq(schema.assistantMessage.userId, userId),
          gte(schema.assistantMessage.createdAt, start),
        ),
      );
    return Number(row?.tokens ?? 0);
  }

  async starters(principal: Principal, query: AssistantStartersQuery): Promise<AssistantStarters> {
    const standing = await this.standing(principal.userId);
    const hasTicket =
      query.ticket !== undefined && (await this.ticketKeyOf(query.ticket, principal)) !== null;
    const [used] = await this.database.db
      .select({ n: sql<string>`count(*)` })
      .from(schema.assistantMessage)
      .where(
        and(
          eq(schema.assistantMessage.userId, principal.userId),
          eq(schema.assistantMessage.role, 'user'),
          gte(schema.assistantMessage.createdAt, new Date(Date.now() - 3_600_000)),
        ),
      );
    return {
      state: standing.state,
      reason: standing.reason,
      starters: startersFor(principal, query.locale, hasTicket),
      limits: {
        messagesPerHour: this.config.ASSISTANT_MESSAGES_PER_HOUR,
        remainingThisHour: Math.max(
          0,
          this.config.ASSISTANT_MESSAGES_PER_HOUR - Number(used?.n ?? 0),
        ),
      },
    };
  }

  /** The key of a ticket the person may see, or null (a chip for a ticket they cannot open is ignored). */
  private async ticketKeyOf(ref: string, principal: Principal): Promise<string | null> {
    try {
      const view = await this.reader.viewRow(ref, principal);
      return this.keys.format(view.t.number);
    } catch {
      return null;
    }
  }

  // --- one message ------------------------------------------------------------------------------

  async message(principal: Principal, body: AssistantMessageRequest): Promise<AssistantReply> {
    const locale = localeOf(body.locale, body.text);
    await this.limiter.enforce(
      'assistant-message',
      principal.userId,
      this.config.ASSISTANT_MESSAGES_PER_HOUR,
      3600,
    );

    // The chip is the person's own claim about where they are: it is checked with their access.
    let ticketKey: string | undefined;
    if (body.context?.ticket !== undefined) {
      const key = await this.ticketKeyOf(body.context.ticket, principal);
      if (key === null) throw notFound('No such ticket');
      ticketKey = key;
    }

    const conversationId = await this.conversationFor(principal, body.conversationId, locale);
    const deps = this.runtime.deps;
    const storage = deps.redactor.session({ scope: conversationId });
    const userBody = storage.redact(body.text);
    const history = await this.history(conversationId);

    const standing = await this.standing(principal.userId);
    let claims: Claim[] = [];
    let tools: AssistantToolRun[] = [];
    let cards: ProposalCard[] = [];
    let state = standing.state;
    let reason = standing.reason;
    let runIds: string[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null };
    const intents: { kind: string; why: string }[] = [];
    const prepared: { intent: Parameters<AssistantProposals['prepare']>[0] }[] = [];

    if (standing.state === 'ok') {
      const host = buildAssistantTools(
        {
          database: this.database,
          reader: this.reader,
          keys: this.keys,
          sla: this.sla,
          kb: this.kb,
          brief: this.brief,
          runner: this.runner,
          embeddingMock: this.config.EMBEDDING_PROVIDER === 'mock',
          aiMock: this.config.AI_PROVIDER === 'mock',
        },
        { principal, locale, masked: isMasked(principal), now: new Date() },
      );
      try {
        const outcome = await runAssistantTurn(deps, {
          scope: conversationId,
          locale,
          role: principal.role,
          ...(body.context?.page === undefined ? {} : { page: body.context.page }),
          ...(ticketKey === undefined ? {} : { ticketInView: ticketKey }),
          today: new Date().toISOString().slice(0, 10),
          text: body.text,
          history,
          host,
          proposalKinds: proposalKindsFor(principal),
          limits: {
            maxToolCalls: ASSISTANT_LIMITS.maxToolCalls,
            maxClaims: ASSISTANT_LIMITS.maxClaims,
            maxProposals: ASSISTANT_LIMITS.maxProposals,
          },
          masked: isMasked(principal),
        });
        if (outcome.status === 'ok') {
          claims = outcome.claims;
          tools = outcome.tools;
          runIds = outcome.runIds;
          usage = outcome.usage;
          prepared.push(...outcome.proposals.map((intent) => ({ intent })));
        } else {
          ({ state, reason } = mapReason(outcome.reason));
          tools = [];
        }
      } catch (error) {
        // An unrecorded model call is withheld (N4): say so, do not guess.
        this.logger.error({ err: error }, 'assistant turn failed');
        state = 'unavailable';
        reason = 'audit_failed';
      }
    }

    // Store both turns, redacted. The answer text is kept as the claims, with personal data replaced.
    const messageId = randomUUID();
    const answerBody =
      claims.length === 0
        ? `[${reason ?? 'no_answer'}]`
        : storage.redact(claims.map((claim) => claim.text).join('\n'));
    await this.database.db.transaction(async (tx) => {
      await tx.insert(schema.assistantMessage).values({
        conversationId,
        userId: principal.userId,
        role: 'user',
        body: userBody,
        context: {
          ...(body.context?.page === undefined ? {} : { page: body.context.page }),
          ...(ticketKey === undefined ? {} : { ticket: ticketKey }),
        },
      });
      await tx.insert(schema.assistantMessage).values({
        id: messageId,
        conversationId,
        userId: principal.userId,
        role: 'assistant',
        body: answerBody,
        tools,
        aiRunIds: runIds,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd === null ? null : String(usage.costUsd),
      });
      await tx
        .update(schema.assistantConversation)
        .set({ updatedAt: sql`clock_timestamp()`, locale })
        .where(eq(schema.assistantConversation.id, conversationId));
    });

    // The cards, made from the server's own reading of each ticket and person. What cannot be made is
    // said in one line, so the person is not left thinking it was done.
    for (const { intent } of prepared) {
      const result = await this.proposals.prepare(intent, {
        principal,
        locale,
        conversationId,
        messageId,
      });
      if (result.ok) cards.push(result.card);
      else intents.push({ kind: result.kind, why: result.why });
    }
    cards = cards.slice(0, ASSISTANT_LIMITS.maxProposals);
    for (const miss of intents) {
      if (claims.length >= ASSISTANT_LIMITS.maxClaims) break;
      const why = NOTES.why[miss.why as keyof typeof NOTES.why];
      claims.push(makeClaim(NOTES.couldNot[locale](miss.kind, why[locale])));
    }

    AuditScope.set({
      action: AUDIT_ACTIONS.assistantMessage,
      targetType: 'assistant_conversation',
      targetId: conversationId,
      metadata: {
        state,
        reason,
        locale,
        tools: tools.map((tool) => `${tool.name}:${tool.status}`),
        runs: runIds.length,
        proposals: cards.map((card) => card.kind),
        masked: isMasked(principal),
      },
    });
    return {
      conversationId,
      messageId,
      state,
      reason,
      locale,
      claims,
      tools,
      proposals: cards,
    };
  }

  private async conversationFor(
    principal: Principal,
    requested: string | undefined,
    locale: AssistantLocale,
  ): Promise<string> {
    const { assistantConversation: table } = schema;
    if (requested !== undefined) {
      // Someone else's conversation is no conversation at all.
      const [found] = await this.database.db
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, requested), eq(table.userId, principal.userId)))
        .limit(1);
      if (found === undefined) throw notFound('No such conversation');
      return found.id;
    }
    const [created] = await this.database.db
      .insert(table)
      .values({ userId: principal.userId, locale })
      .returning({ id: table.id });
    if (created === undefined) throw new Error('conversation not stored');
    return created.id;
  }

  private async history(
    conversationId: string,
  ): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
    const rows = await this.database.db
      .select({ role: schema.assistantMessage.role, text: schema.assistantMessage.body })
      .from(schema.assistantMessage)
      .where(eq(schema.assistantMessage.conversationId, conversationId))
      .orderBy(desc(schema.assistantMessage.createdAt))
      .limit(ASSISTANT_LIMITS.historyTurns);
    return rows.reverse();
  }

  async deleteConversation(principal: Principal, id: string): Promise<void> {
    const { assistantConversation: table } = schema;
    const deleted = await this.database.db
      .delete(table)
      .where(and(eq(table.id, id), eq(table.userId, principal.userId)))
      .returning({ id: table.id });
    if (deleted.length === 0) throw notFound('No such conversation');
    AuditScope.set({
      action: AUDIT_ACTIONS.assistantConversationDelete,
      targetType: 'assistant_conversation',
      targetId: id,
    });
  }
}

function mapReason(reason: string): Standing {
  switch (reason) {
    case 'kill_switch_on':
    case 'policy_denied':
      return { state: 'paused', reason };
    case 'budget_stop':
      return { state: 'budget', reason };
    default:
      // name_match_limit, provider_*, model_output_invalid, audit_failed: nothing usable came back.
      return { state: 'unavailable', reason };
  }
}
