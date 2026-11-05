import { randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
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
import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';

import { AI_RUNTIME, type AiRuntime } from '../ai/ai-runtime.js';
import { AiStatusService } from '../ai/ai-status.service.js';
import { StaffNames } from '../ai/staff-names.service.js';
import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiHttpError, notFound } from '../auth/http-errors.js';
import { orgPeopleNames } from '../masking/org-names.js';
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
import { ContextResolver } from './context-resolver.js';
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
  | 'ASSISTANT_RETENTION_DAYS'
  | 'EMBEDDING_PROVIDER'
>;

const THAI = /[฀-๿]/;
/** Tickets named in what the person typed whose organizations' people are given to the redactor. */
const MAX_TYPED_TICKETS = 5;
const TICKET_REF_IN_TEXT = /\b[A-Za-z][A-Za-z0-9]{1,9}-\d{1,15}\b/g;

/** Thai in the text means a Thai screen when the web did not say. */
export function localeOf(requested: AssistantLocale | undefined, text: string): AssistantLocale {
  return requested ?? (THAI.test(text) ? 'th' : 'en');
}

interface Standing {
  readonly state: AssistantState;
  readonly reason: string | null;
}

/**
 * The assistant (T-134, ADR-023). One message is: checks that need no model (rate, the person's
 * budget, the system's state), then two audited model calls around the tools the person's role and
 * permissions allow, then the cards for what the person asked to change. It stores only redacted
 * text. It cannot write anything: the writes are in `AssistantProposals` and wait for a press.
 */
@Injectable()
export class AssistantService {
  /**
   * People whose message is being answered right now (T-155a C-4): one at a time each, so one person
   * cannot hold every model slot with several tabs or a script. Per api process, like the slot limit.
   */
  private readonly inFlight = new Set<string>();

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
    @Inject(ContextResolver) private readonly contexts: ContextResolver,
    @Inject(StaffNames) private readonly staff: StaffNames,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AiStatusService) private readonly aiStatus: AiStatusService,
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
    // A real provider whose host the worker reports offline (T-170): say so without a model call.
    if (this.config.AI_PROVIDER !== 'mock' && (await this.aiStatus.status()).status === 'offline') {
      return { state: 'unavailable', reason: 'provider_offline' };
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

  /**
   * Tokens this person has used today (UTC), from `assistant_usage`: a table of its own, so deleting a
   * conversation (messages and all) gives none of the budget back.
   */
  private async tokensToday(userId: string, now: Date): Promise<number> {
    const [row] = await this.database.db
      .select({
        tokens: sql<string>`(${schema.assistantUsage.inputTokens} + ${schema.assistantUsage.outputTokens})::text`,
      })
      .from(schema.assistantUsage)
      .where(
        and(
          eq(schema.assistantUsage.userId, userId),
          eq(schema.assistantUsage.day, now.toISOString().slice(0, 10)),
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
    return (await this.ticketOf(ref, principal))?.key ?? null;
  }

  private async ticketOf(
    ref: string,
    principal: Principal,
  ): Promise<{ key: string; orgId: string } | null> {
    try {
      const view = await this.reader.viewRow(ref, principal);
      return { key: this.keys.format(view.t.number), orgId: view.t.orgId };
    } catch {
      return null;
    }
  }

  /**
   * The people of the organizations of the tickets this message is about (the chip, and any ticket number
   * the person typed): what they type, and what they said before, can name any of them, and the redactor
   * only replaces names it is given (N4). `complete` is false when an organization had more people than the
   * redactor can take: then nothing of the message goes to a model.
   */
  private async aboutOrgNames(
    principal: Principal,
    chip: string | undefined,
    text: string,
    earlier: readonly string[],
    chipOrgIds: readonly string[] = [],
  ): Promise<{ names: string[]; complete: boolean; orgIds: string[] }> {
    const refs = [
      ...(chip === undefined ? [] : [chip]),
      ...(text.match(TICKET_REF_IN_TEXT) ?? []).slice(0, MAX_TYPED_TICKETS),
      // A later turn with no ticket in it still carries what was said about the tickets before.
      ...earlier,
    ];
    const orgIds = new Set<string>(chipOrgIds);
    for (const ref of new Set(refs)) {
      const found = await this.ticketOf(ref, principal);
      if (found !== null) orgIds.add(found.orgId);
    }
    const people = await orgPeopleNames(this.database.db, [...orgIds]);
    return { names: people.names, complete: people.complete, orgIds: [...orgIds] };
  }

  // --- one message ------------------------------------------------------------------------------

  /**
   * One message. A second one from the same person while the first is unanswered is 429 `assistant_busy`
   * (before anything is counted or sent). `signal` aborts the model calls when the person goes away.
   */
  async message(
    principal: Principal,
    body: AssistantMessageRequest,
    signal?: AbortSignal,
  ): Promise<AssistantReply> {
    if (this.inFlight.has(principal.userId)) {
      throw new ApiHttpError(
        HttpStatus.TOO_MANY_REQUESTS,
        'assistant_busy',
        'The assistant is still answering your last message; wait for it to finish',
      );
    }
    this.inFlight.add(principal.userId);
    try {
      return await this.answer(principal, body, signal);
    } finally {
      this.inFlight.delete(principal.userId);
    }
  }

  private async answer(
    principal: Principal,
    body: AssistantMessageRequest,
    signal: AbortSignal | undefined,
  ): Promise<AssistantReply> {
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

    // The other chips (entity, selection): each ref is read with the reader of its module under this person's access.
    // One that does not exist and one that is not theirs are dropped the same way (ADR-029 section 1).
    const resolved = await this.contexts.resolve(body.context, principal);
    if (ticketKey === undefined && resolved.entity?.kind === 'ticket')
      ticketKey = resolved.entity.label;

    const conversationId = await this.conversationFor(principal, body.conversationId, locale);
    // Every redactor of this message knows the staff of the instance, so a colleague's name in what the
    // person typed, or in a ticket, is replaced before a model sees it, and before it is stored (N4).
    const earlier = await this.ticketsOfConversation(conversationId);
    const about = await this.aboutOrgNames(
      principal,
      ticketKey,
      body.text,
      earlier,
      // The organizations of every other chip too: their people go to the redactor (N4).
      resolved.refs.flatMap((ref) => (ref.orgId == null ? [] : [ref.orgId])),
    );
    const staff = await this.staff.list();
    // Both lists must be whole, or the redactor cannot be trusted with the text (fail closed).
    const listsWhole = about.complete && staff.complete;
    const staffNames = [...staff.names, ...about.names];
    const base = this.runtime.deps;
    const deps = {
      ...base,
      redactor: base.redactorFor?.(staffNames) ?? base.redactor,
      redactorFor: (names: readonly string[]) =>
        base.redactorFor?.([...names, ...staffNames]) ?? base.redactor,
    };
    const read = new Map<string, string>();
    const history = await this.history(conversationId);
    let toolNames: string[] = [];

    const standing = await this.standing(principal.userId);
    let claims: Claim[] = [];
    // What is stored and sent back to a model as history: the model's words, placeholders in.
    let redactedAnswer = '';
    let tools: AssistantToolRun[] = [];
    let cards: ProposalCard[] = [];
    let state = standing.state;
    let reason = standing.reason;
    let runIds: string[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: null as number | null };
    const intents: { kind: string; why: string }[] = [];
    const prepared: { intent: Parameters<AssistantProposals['prepare']>[0] }[] = [];

    if (standing.state === 'ok' && !listsWhole) {
      // The people could not all be listed, so the redactor cannot be trusted with the text: nothing is sent
      // to a model, nothing of what was typed is stored (N4), and the person is told why.
      state = 'unavailable';
      reason = 'names_incomplete';
    }

    if (standing.state === 'ok' && listsWhole) {
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
        {
          principal,
          locale,
          masked: isMasked(principal),
          now: new Date(),
          onRead: (ticket) => {
            read.set(ticket.id, ticket.key);
          },
        },
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
          ...(signal === undefined ? {} : { abortSignal: signal }),
        });
        if (outcome.status === 'ok') {
          claims = outcome.claims;
          redactedAnswer = outcome.redactedText;
          toolNames = outcome.names;
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

    // Store both turns redacted. The answer is kept as the model wrote it, placeholders in: the restored
    // text (names, subjects) is for the screen and is neither stored nor sent to a model again (N4).
    const messageId = randomUUID();
    const userBody = listsWhole
      ? (base.redactorFor?.([...staffNames, ...toolNames]) ?? base.redactor)
          .session({ scope: conversationId })
          .redact(body.text)
      : '[names_incomplete]';
    const answerBody =
      redactedAnswer === '' ? `[${reason ?? 'no_answer'}]` : redactedAnswer.slice(0, 20_000);
    await this.database.db.transaction(async (tx) => {
      await tx.insert(schema.assistantMessage).values({
        conversationId,
        userId: principal.userId,
        role: 'user',
        body: userBody,
        context: {
          ...(body.context?.page === undefined ? {} : { page: body.context.page }),
          ...(ticketKey === undefined ? {} : { ticket: ticketKey }),
          ...(resolved.entity === null
            ? {}
            : { entity: { kind: resolved.entity.kind, ref: resolved.entity.label } }),
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
      // The day's numbers of this person, apart from the conversation (it can be deleted; this cannot).
      await tx
        .insert(schema.assistantUsage)
        .values({
          userId: principal.userId,
          day: new Date().toISOString().slice(0, 10),
          messages: 1,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd === null ? null : String(usage.costUsd),
        })
        .onConflictDoUpdate({
          target: [schema.assistantUsage.userId, schema.assistantUsage.day],
          set: {
            messages: sql`${schema.assistantUsage.messages} + 1`,
            inputTokens: sql`${schema.assistantUsage.inputTokens} + ${usage.inputTokens}`,
            outputTokens: sql`${schema.assistantUsage.outputTokens} + ${usage.outputTokens}`,
            costUsd:
              usage.costUsd === null
                ? schema.assistantUsage.costUsd
                : sql`coalesce(${schema.assistantUsage.costUsd}, 0) + ${usage.costUsd}`,
          },
        });
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
      if (result.ok) {
        cards.push(result.card);
        // A card shows the subject of its ticket: that is a read too, whether or not a tool read it first.
        if (result.ticketId !== null) read.set(result.ticketId, result.card.target?.key ?? '');
      } else intents.push({ kind: result.kind, why: result.why });
    }
    cards = cards.slice(0, ASSISTANT_LIMITS.maxProposals);
    for (const miss of intents) {
      if (claims.length >= ASSISTANT_LIMITS.maxClaims) break;
      const why = NOTES.why[miss.why as keyof typeof NOTES.why];
      claims.push(makeClaim(NOTES.couldNot[locale](miss.kind, why[locale])));
    }

    // Tickets whose content the assistant read for this person are personal data read (PRD 8.2): one
    // `pii.read` row each, like the ticket page, so the log says who looked at which ticket.
    for (const [ticketId] of read) {
      await this.audit.recordPiiRead({
        actor: { type: 'user', id: principal.userId },
        targetType: 'ticket',
        targetId: ticketId,
        metadata: { via: 'assistant', conversationId },
      });
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
        ticketIds: [...read.keys()],
        // `context_dropped` (T-400 C-20): how many and of which kind, never the refs that were sent.
        contextDropped: countByKind(resolved.dropped),
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
        .where(
          and(
            eq(table.id, requested),
            eq(table.userId, principal.userId),
            // Also gone once it is older than the retention, however recently it was used.
            gt(
              table.createdAt,
              sql`now() - make_interval(days => ${this.config.ASSISTANT_RETENTION_DAYS})`,
            ),
          ),
        )
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

  /** The tickets earlier turns of this conversation were about (their chips), to give their people to the redactor. */
  private async ticketsOfConversation(conversationId: string): Promise<string[]> {
    const rows = await this.database.db
      .selectDistinct({ ticket: sql<string | null>`${schema.assistantMessage.context}->>'ticket'` })
      .from(schema.assistantMessage)
      .where(eq(schema.assistantMessage.conversationId, conversationId))
      .limit(20);
    return rows.flatMap((row) => (row.ticket === null ? [] : [row.ticket]));
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

function countByKind(dropped: readonly { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { kind } of dropped) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
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
