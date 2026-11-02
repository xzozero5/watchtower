import { randomBytes } from 'node:crypto';

import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { ProposalIntent } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  AI_REQUEST_LIMITS,
  ASSISTANT_LIMITS,
  AUDIT_ACTIONS,
  STAFF_ROLES,
  aiRequestSchema,
  assignTicketSchema,
  changeStatusSchema,
  createKbArticleSchema,
  createTicketSchema,
  noteSchema,
  proposalCardSchema,
  updateTicketSchema,
  SETTABLE_STATUSES,
  type AssistantLocale,
  type ConfirmProposalResponse,
  type ProposalCard,
  type ProposalChange,
  type ProposalKind,
  type RejectProposalResponse,
  type TicketStatus,
} from '@watchtower/shared';
import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import { TicketAiService } from '../ai/ticket-ai.service.js';
import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { conflict, forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { DATABASE } from '../database/database.module.js';
import { actorOf } from '../kb/kb-actor.js';
import { KbService } from '../kb/kb.service.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader, type TicketViewRow } from '../tickets/ticket-reader.js';
import { TicketsService } from '../tickets/tickets.service.js';
import { WorkflowService } from '../tickets/workflow.service.js';
import { PROPOSAL_PERMISSION } from './assistant-access.js';
import { ticketHref } from './assistant-hrefs.js';
import { statusWord, type ProposalWhy } from './assistant-text.js';

type ProposalRow = typeof schema.assistantProposal.$inferSelect;

/** What is stored of the card: the rest of it (id, status, expiry) is columns. */
type StoredCard = {
  /** The language the card was written in, to write it again if it turns stale. */
  locale: AssistantLocale;
  target: ProposalCard['target'];
  changes: ProposalChange[];
  text?: string;
};

/** The facts a proposal was made for, and the write that will run if it is pressed. */
interface Prepared {
  readonly kind: ProposalKind;
  readonly ticketId: string | null;
  readonly baseUpdatedAt: Date | null;
  readonly params: Record<string, unknown>;
  readonly card: StoredCard;
}

/** What a builder returns: the card is given its language when the proposal is stored. */
type Built = Omit<Prepared, 'card'> & { readonly card: Omit<StoredCard, 'locale'> };

export type PrepareResult =
  | { readonly ok: true; readonly card: ProposalCard }
  | { readonly ok: false; readonly kind: ProposalKind; readonly why: ProposalWhy };

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const fail = (kind: ProposalKind, why: ProposalWhy): PrepareResult => ({ ok: false, kind, why });

/** The audit row the confirm writes in the same transaction as the change (ADR-017 section 4). */
const CONFIRM_ACTION = AUDIT_ACTIONS.assistantProposalConfirm;

/** A slug from a title: letters and digits, or a random one when the title has none (Thai, for one). */
export function slugFor(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 100)
    .replaceAll(/-+$/g, '');
  const suffix = randomBytes(3).toString('hex');
  return base === '' ? `draft-${suffix}` : `${base}-${suffix}`;
}

/**
 * Proposals: a write the assistant suggests, held as a card made of server values (ADR-017 sections
 * 3 and 4). `prepare` turns the model's intent into a card or into a stated reason why not; `confirm`
 * runs it once, for its owner, with their permissions and through the same services as the ordinary
 * route; `reject` closes it. Nothing here is reachable by a model: only a person's press gets to
 * `confirm`.
 */
@Injectable()
export class AssistantProposals {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly reader: TicketReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(WorkflowService) private readonly workflow: WorkflowService,
    @Inject(KbService) private readonly kb: KbService,
    @Inject(TicketAiService) private readonly ai: TicketAiService,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  // --- prepare ----------------------------------------------------------------------------------

  async prepare(
    intent: ProposalIntent,
    context: {
      readonly principal: Principal;
      readonly locale: AssistantLocale;
      readonly conversationId: string;
      readonly messageId: string;
    },
  ): Promise<PrepareResult> {
    const { principal } = context;
    if (!principal.permissions.has(PROPOSAL_PERMISSION[intent.kind])) {
      return fail(intent.kind, 'not_allowed');
    }
    const built = await this.build(intent, principal, context.locale);
    if ('why' in built) return fail(intent.kind, built.why);
    const prepared: Prepared = { ...built, card: { ...built.card, locale: context.locale } };

    const [row] = await this.database.db
      .insert(schema.assistantProposal)
      .values({
        conversationId: context.conversationId,
        messageId: context.messageId,
        userId: principal.userId,
        kind: prepared.kind,
        ticketId: prepared.ticketId,
        params: prepared.params,
        card: prepared.card,
        baseUpdatedAt: prepared.baseUpdatedAt,
        // The database clock on both sides: the app and the database clocks have disagreed before.
        expiresAt: sql`clock_timestamp() + make_interval(mins => ${ASSISTANT_LIMITS.proposalTtlMinutes})`,
      })
      .returning();
    if (row === undefined) throw new Error('proposal not stored');
    return { ok: true, card: toCard(row) };
  }

  private async build(
    intent: ProposalIntent,
    principal: Principal,
    locale: AssistantLocale,
  ): Promise<Built | { readonly why: ProposalWhy }> {
    switch (intent.kind) {
      case 'create_ticket':
        return this.buildCreate(intent);
      case 'kb_draft':
        return this.buildKb(intent, locale);
    }
    let view: TicketViewRow;
    try {
      view = await this.reader.viewRow(intent.ticket, principal);
    } catch {
      return { why: 'ticket_not_found' };
    }
    const key = this.keys.format(view.t.number);
    const target = { key, label: cut(view.t.subject, 120), href: ticketHref(key) };
    const base = { ticketId: view.t.id, baseUpdatedAt: view.t.updatedAt };

    switch (intent.kind) {
      case 'assign': {
        let assignee: { id: string; name: string } | null = null;
        if (intent.assignee !== null) {
          const found = await this.findStaff(intent.assignee);
          if ('why' in found) return found;
          assignee = found;
        }
        const body = assignTicketSchema.safeParse({ assigneeId: assignee?.id ?? null });
        if (!body.success) return { why: 'invalid' };
        if ((view.t.assigneeId ?? null) === (assignee?.id ?? null)) return { why: 'no_change' };
        return {
          kind: 'assign',
          ...base,
          params: { assigneeId: assignee?.id ?? null },
          card: {
            target,
            changes: [{ field: 'assignee', from: view.assigneeName, to: assignee?.name ?? null }],
          },
        };
      }
      case 'status': {
        if (!(SETTABLE_STATUSES as readonly string[]).includes(intent.status)) {
          return { why: 'invalid' };
        }
        if (view.t.status === intent.status) return { why: 'no_change' };
        if (!(await this.workflow.allows(view.t.status as TicketStatus, intent.status))) {
          return { why: 'transition' };
        }
        const body = changeStatusSchema.safeParse({ status: intent.status, reason: intent.reason });
        if (!body.success) return { why: 'invalid' };
        return {
          kind: 'status',
          ...base,
          params: {
            status: intent.status,
            ...(intent.reason === undefined ? {} : { reason: intent.reason }),
          },
          card: {
            target,
            changes: [
              {
                field: 'status',
                from: statusWord(locale, view.t.status),
                to: statusWord(locale, intent.status),
              },
            ],
            ...(intent.reason === undefined ? {} : { text: intent.reason }),
          },
        };
      }
      case 'tag': {
        const remove = new Set((intent.remove ?? []).map((tag) => tag.trim()));
        const next = [
          ...new Set([...view.t.tags, ...(intent.add ?? []).map((tag) => tag.trim())]),
        ].filter((tag) => !remove.has(tag));
        if (next.join('\n') === view.t.tags.join('\n')) return { why: 'no_change' };
        const body = updateTicketSchema.safeParse({ tags: next });
        if (!body.success) return { why: 'invalid' };
        return {
          kind: 'tag',
          ...base,
          params: { tags: next },
          card: {
            target,
            changes: [
              { field: 'tags', from: view.t.tags.join(', ') || null, to: next.join(', ') || null },
            ],
          },
        };
      }
      case 'note': {
        const body = noteSchema.safeParse({ body: intent.body });
        if (!body.success) return { why: 'invalid' };
        return {
          kind: 'note',
          ...base,
          params: { body: body.data.body },
          card: { target, changes: [], text: body.data.body },
        };
      }
      case 'reply_draft': {
        // The same refusal as the button: a draft needs an intent on the ticket.
        if (view.t.intentId === null) return { why: 'no_intent' };
        const body = aiRequestSchema.safeParse({ kind: 'draft', note: intent.instruction });
        if (!body.success) return { why: 'invalid' };
        return {
          kind: 'reply_draft',
          ...base,
          params: { ...(intent.instruction === undefined ? {} : { note: intent.instruction }) },
          card: {
            target,
            changes: [],
            ...(intent.instruction === undefined ? {} : { text: intent.instruction }),
          },
        };
      }
    }
  }

  /** One active staff member by address, or by name (exact first, then a part of it). */
  private async findStaff(
    who: string,
  ): Promise<{ id: string; name: string } | { readonly why: ProposalWhy }> {
    const text = who.trim();
    if (text.length < 2) return { why: 'assignee_not_found' };
    const like = `%${text.replaceAll(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const rows = await this.database.db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.status, 'active'),
          inArray(schema.users.role, [...STAFF_ROLES]),
          or(ilike(schema.users.email, like), ilike(schema.users.name, like)),
        ),
      )
      .limit(10);
    const lower = text.toLowerCase();
    const exact = rows.filter(
      (row) => row.email.toLowerCase() === lower || row.name.toLowerCase() === lower,
    );
    const pool = exact.length > 0 ? exact : rows;
    if (pool.length === 0) return { why: 'assignee_not_found' };
    if (pool.length > 1) return { why: 'assignee_ambiguous' };
    const [only] = pool;
    return only === undefined ? { why: 'assignee_not_found' } : { id: only.id, name: only.name };
  }

  private async buildCreate(
    intent: Extract<ProposalIntent, { kind: 'create_ticket' }>,
  ): Promise<Built | { readonly why: ProposalWhy }> {
    const orgs = await this.database.db
      .select({ id: schema.organization.id, name: schema.organization.name })
      .from(schema.organization)
      .where(
        ilike(
          schema.organization.name,
          intent.org.trim().replaceAll(/[\\%_]/g, (c) => `\\${c}`),
        ),
      )
      .limit(3);
    if (orgs.length === 0) return { why: 'org_not_found' };
    if (orgs.length > 1) return { why: 'org_ambiguous' };
    const [org] = orgs;
    if (org === undefined) return { why: 'org_not_found' };
    const requester =
      intent.requesterEmail === undefined
        ? undefined
        : {
            email: intent.requesterEmail,
            name:
              intent.requesterName ?? intent.requesterEmail.split('@')[0] ?? intent.requesterEmail,
          };
    const body = createTicketSchema.safeParse({
      orgId: org.id,
      subject: intent.subject,
      body: intent.body,
      ...(requester === undefined ? {} : { requester }),
    });
    if (!body.success) return { why: 'invalid' };
    return {
      kind: 'create_ticket',
      ticketId: null,
      baseUpdatedAt: null,
      params: body.data,
      card: {
        target: null,
        changes: [
          { field: 'org', from: null, to: org.name },
          { field: 'subject', from: null, to: cut(body.data.subject, 300) },
          ...(requester === undefined
            ? []
            : [{ field: 'requester', from: null, to: cut(requester.email, 300) }]),
        ],
        text: body.data.body,
      },
    };
  }

  private buildKb(
    intent: Extract<ProposalIntent, { kind: 'kb_draft' }>,
    locale: AssistantLocale,
  ): Built | { readonly why: ProposalWhy } {
    const body = createKbArticleSchema.safeParse({
      slug: slugFor(intent.title),
      title: intent.title,
      bodyMd: intent.bodyMd,
      lang: locale,
      kind: 'article',
      visibility: 'internal',
    });
    if (!body.success) return { why: 'invalid' };
    return {
      kind: 'kb_draft',
      ticketId: null,
      baseUpdatedAt: null,
      params: body.data,
      card: {
        target: null,
        changes: [{ field: 'title', from: null, to: cut(body.data.title, 300) }],
        text: body.data.bodyMd,
      },
    };
  }

  // --- confirm ----------------------------------------------------------------------------------

  /**
   * Runs the proposal for its owner. In one transaction: the proposal is read under a row lock, so two
   * presses cannot both run it; it must be the owner's (anyone else: 404), pending and not expired
   * (database clock); the owner's permission is checked again; the ticket is locked and compared with
   * what the card was made from (a changed ticket closes the card as stale and runs nothing); then the
   * ordinary service does the work as the owner, and one `assistant.proposal.confirm` audit row says it
   * came from the assistant. Any error rolls everything back and closes the proposal as failed.
   */
  async confirm(principal: Principal, id: string): Promise<ConfirmProposalResponse> {
    let outcome: ConfirmOutcome;
    try {
      outcome = await this.uow.run((uow) => this.confirmIn(uow, principal, id));
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() >= 400) {
        const status = error.getStatus();
        // 404 (not yours, not there) and 409 (already used) leave the row as it is; a refusal while
        // running closes the proposal, so a press that failed is not left looking pending.
        if (status !== 404 && status !== 409) await this.closeFailed(principal.userId, id, status);
      }
      throw error;
    }
    if (outcome.kind === 'expired') throw conflict('This proposal has expired');
    const row = await this.rowOf(principal.userId, id);
    if (outcome.kind === 'stale') {
      return {
        outcome: 'stale',
        proposal: toCard(row, outcome.refreshed),
        result: null,
      };
    }
    return { outcome: 'done', proposal: toCard(row), result: outcome.result };
  }

  private async confirmIn(
    uow: UnitOfWork,
    principal: Principal,
    id: string,
  ): Promise<ConfirmOutcome> {
    const { assistantProposal: table } = schema;
    const [found] = await uow.tx
      .select({
        row: table,
        expired: sql<boolean>`${table.expiresAt} <= clock_timestamp()`,
      })
      .from(table)
      .where(eq(table.id, id))
      .for('update')
      .limit(1);
    // Someone else's proposal looks like no proposal at all.
    if (found === undefined || found.row.userId !== principal.userId) {
      throw notFound('No such proposal');
    }
    const row = found.row;
    if (row.status !== 'pending') throw conflict('This proposal was already used or closed');
    if (found.expired) {
      await this.close(uow, id, 'expired', 'expired');
      return { kind: 'expired' };
    }
    const kind = row.kind as ProposalKind;
    if (!principal.permissions.has(PROPOSAL_PERMISSION[kind])) throw forbidden();

    let view: TicketViewRow | null = null;
    if (row.ticketId !== null) {
      // The ticket the card was made for, as this person may see it now (404 if they lost access).
      view = await this.reader.viewRow(row.ticketId, principal, uow.tx);
      const locked = await this.tickets.lock(uow.tx, row.ticketId);
      if (
        row.baseUpdatedAt === null ||
        locked.updatedAt.getTime() !== row.baseUpdatedAt.getTime()
      ) {
        await this.close(uow, id, 'expired', 'stale');
        return { kind: 'stale', refreshed: refreshChanges(row, view) };
      }
    }

    const result = await this.run(uow, principal, row, view);
    await this.close(uow, id, 'confirmed', null);
    await this.audit.recordInTransaction(uow.tx, {
      actor: { type: 'user', id: principal.userId },
      action: CONFIRM_ACTION,
      targetType: row.ticketId === null ? 'assistant_proposal' : 'ticket',
      targetId: row.ticketId ?? id,
      metadata: {
        via: 'assistant',
        proposalId: id,
        conversationId: row.conversationId,
        kind,
        ...(result.key === null ? {} : { resultKey: result.key }),
      },
    });
    return { kind: 'done', result };
  }

  /** The ordinary service for the kind, as the owner. The ids and values are the ones on the card. */
  private async run(
    uow: UnitOfWork,
    principal: Principal,
    row: ProposalRow,
    view: TicketViewRow | null,
  ): Promise<{ key: string | null; href: string | null }> {
    const actor = actorOf(principal);
    const params = row.params;
    const ticketId = row.ticketId;
    const key = view === null ? null : this.keys.format(view.t.number);
    const hrefOf = (k: string | null): string | null => (k === null ? null : ticketHref(k));
    switch (row.kind as ProposalKind) {
      case 'assign': {
        const body = assignTicketSchema.parse({ assigneeId: params.assigneeId ?? null });
        await this.tickets.assign(uow, need(ticketId), body, actor);
        return { key, href: hrefOf(key) };
      }
      case 'status': {
        const body = changeStatusSchema.parse(params);
        await this.tickets.changeStatus(uow, need(ticketId), body.status, actor, body.reason);
        return { key, href: hrefOf(key) };
      }
      case 'tag': {
        const body = updateTicketSchema.parse({ tags: params.tags });
        await this.tickets.update(uow, need(ticketId), body, actor);
        return { key, href: hrefOf(key) };
      }
      case 'note': {
        const body = noteSchema.parse(params);
        await this.tickets.note(uow, need(ticketId), body, { userId: principal.userId }, actor);
        return { key, href: hrefOf(key) };
      }
      case 'create_ticket': {
        const body = createTicketSchema.parse(params);
        if (body.orgId === undefined) throw new Error('proposal without an organization');
        const created = await this.tickets.create(uow, {
          actor,
          orgId: body.orgId,
          subject: body.subject,
          body: body.body,
          ...(body.requester === undefined ? {} : { requester: body.requester }),
        });
        const newKey = this.keys.format(created.ticket.number);
        return { key: newKey, href: ticketHref(newKey) };
      }
      case 'kb_draft': {
        const body = createKbArticleSchema.parse(params);
        const article = await this.kb.create(uow, actor, body);
        return { key: article.slug, href: null };
      }
      case 'reply_draft': {
        // Same limit as the button: a draft on request is a model call with no tool call to bound it.
        await this.limiter.enforce(
          'ai-request',
          principal.userId,
          AI_REQUEST_LIMITS.perUserPerHour,
          3600,
        );
        const body = aiRequestSchema.parse({ kind: 'draft', note: params.note });
        await this.ai.request(uow, need(ticketId), body, principal);
        return { key, href: hrefOf(key) };
      }
    }
  }

  /** Marks the proposal decided inside the transaction and drops the free text it carried. */
  private async close(
    uow: UnitOfWork,
    id: string,
    status: 'confirmed' | 'expired' | 'rejected',
    failCode: string | null,
  ): Promise<void> {
    const { assistantProposal: table } = schema;
    await uow.tx
      .update(table)
      .set({
        status,
        failCode,
        decidedAt: sql`clock_timestamp()`,
        params: sql`'{}'::jsonb`,
        card: sql`${table.card} - 'text'`,
      })
      .where(eq(table.id, id));
  }

  private async closeFailed(userId: string, id: string, status: number): Promise<void> {
    const { assistantProposal: table } = schema;
    await this.database.db
      .update(table)
      .set({
        status: 'failed',
        failCode: `http_${String(status)}`,
        decidedAt: sql`clock_timestamp()`,
        params: sql`'{}'::jsonb`,
        card: sql`${table.card} - 'text'`,
      })
      .where(and(eq(table.id, id), eq(table.userId, userId), eq(table.status, 'pending')));
  }

  // --- reject -----------------------------------------------------------------------------------

  async reject(principal: Principal, id: string): Promise<RejectProposalResponse> {
    const row = await this.uow.run(async (uow) => {
      const { assistantProposal: table } = schema;
      const [found] = await uow.tx
        .select()
        .from(table)
        .where(eq(table.id, id))
        .for('update')
        .limit(1);
      if (found === undefined || found.userId !== principal.userId) {
        throw notFound('No such proposal');
      }
      if (found.status !== 'pending') throw conflict('This proposal was already used or closed');
      await this.close(uow, id, 'rejected', null);
      return found;
    });
    AuditScope.set({
      action: AUDIT_ACTIONS.assistantProposalReject,
      targetType: 'assistant_proposal',
      targetId: id,
      metadata: { via: 'assistant', kind: row.kind, conversationId: row.conversationId },
    });
    return { proposal: toCard(await this.rowOf(principal.userId, id)) };
  }

  private async rowOf(userId: string, id: string): Promise<ProposalRow> {
    const [row] = await this.database.db
      .select()
      .from(schema.assistantProposal)
      .where(and(eq(schema.assistantProposal.id, id), eq(schema.assistantProposal.userId, userId)))
      .limit(1);
    if (row === undefined) throw notFound('No such proposal');
    return row;
  }
}

type ConfirmOutcome =
  | { readonly kind: 'done'; readonly result: { key: string | null; href: string | null } }
  | { readonly kind: 'stale'; readonly refreshed: ProposalChange[] }
  | { readonly kind: 'expired' };

function need(ticketId: string | null): string {
  if (ticketId === null) throw new Error('proposal without a ticket');
  return ticketId;
}

/** The card with the values that are true now in the `from` of each change (a stale card shows them). */
function refreshChanges(row: ProposalRow, view: TicketViewRow): ProposalChange[] {
  const stored = row.card as unknown as StoredCard;
  return stored.changes.map((change) => {
    switch (change.field) {
      case 'assignee':
        return { ...change, from: view.assigneeName };
      case 'status':
        return { ...change, from: statusWord(stored.locale, view.t.status) };
      case 'tags':
        return { ...change, from: view.t.tags.join(', ') || null };
      default:
        return change;
    }
  });
}

export function toCard(row: ProposalRow, changes?: ProposalChange[]): ProposalCard {
  const stored = row.card as unknown as StoredCard;
  return proposalCardSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    target: stored.target,
    changes: changes ?? stored.changes,
    ...(stored.text === undefined ? {} : { text: stored.text }),
    expiresAt: row.expiresAt.toISOString(),
  });
}
