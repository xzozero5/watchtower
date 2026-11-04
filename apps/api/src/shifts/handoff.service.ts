import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { assertAssignableStaff, type Domain } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  HANDOFF_VISIBLE_HOURS,
  OPEN_STATUSES,
  addDaysToDateKey,
  handoffBlockers,
  isHandoffRequiredPriority,
  itemRequiresAck,
  localDateKeyOf,
  shiftWindow,
  type AckHandoffItem,
  type AckResult,
  type AssistantLocale,
  type CurrentHandoff,
  type Handoff,
  type HandoffAiPrefillResponse,
  type IncomingHandoffs,
  type SaveHandoff,
} from '@watchtower/shared';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import { AiSummaries, joinClaims } from '../ai/ai-summaries.service.js';
import { customerNamesOfTickets } from '../ai/customer-names.js';
import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { assertOrgAccess, type Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { domainContext, settle } from '../domain/domain-context.js';
import { translating } from '../domain/domain-errors.js';
import { DOMAIN } from '../domain/domain.module.js';
import { UnitOfWorkService, type UnitOfWork } from '../realtime/unit-of-work.js';
import { StaffUploadsService } from '../uploads/staff-uploads.service.js';
import { assertCanRead } from '../tickets/ticket-reader.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { briefHandoffFacts } from './brief-facts.js';
import { HandoffReader } from './handoff-reader.js';
import {
  HandoffIncompleteError,
  HandoffLockedError,
  SHIFT_NOW,
  openSessionOf,
  type ShiftNow,
  shiftTimezone,
} from './shift-core.js';

type Tx = UnitOfWork['tx'];

/**
 * The outgoing person's handoff (R-7.5) and the incoming person's acknowledgment of its items
 * (R-7.6). Everything here is a mutation in one transaction with its audit row. The data is read by
 * `HandoffReader`.
 */
@Injectable()
export class HandoffService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(HandoffReader) private readonly reader: HandoffReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
    @Inject(SHIFT_NOW) private readonly now: ShiftNow,
    @Inject(StaffUploadsService) private readonly uploads: StaffUploadsService,
    @Inject(AiSummaries) private readonly summaries: AiSummaries,
  ) {}

  // --- reads ---

  /** The handoff of the caller's open session, with what the gate says and who is rostered next. */
  async current(principal: Principal): Promise<CurrentHandoff> {
    const db = this.database.db;
    const session = await openSessionOf(db, principal.userId);
    if (session === undefined) {
      return {
        handoff: null,
        gate: { noConfirmedHandoff: true, blockers: [] },
        incomingCandidates: [],
      };
    }
    const handoffId = await this.reader.idOfSession(db, session.s.id);
    return {
      handoff: handoffId === null ? null : await this.reader.view(db, handoffId),
      gate: await this.reader.gate(db, principal.userId, session.s.id),
      incomingCandidates: await this.incomingCandidates(principal.userId, session.s.scheduledEnd),
    };
  }

  incoming(principal: Principal): Promise<IncomingHandoffs> {
    return this.reader.incoming(this.database.db, principal.userId);
  }

  /** People rostered to start from an hour before to two hours after the end of this shift. */
  private async incomingCandidates(
    userId: string,
    scheduledEnd: Date | null,
  ): Promise<CurrentHandoff['incomingCandidates']> {
    const db = this.database.db;
    const around = scheduledEnd ?? this.now();
    const from = new Date(around.getTime() - 3_600_000);
    const to = new Date(around.getTime() + 2 * 3_600_000);
    const timezone = await shiftTimezone(db);
    const today = localDateKeyOf(this.now(), timezone);
    const rows = await db
      .select({
        entry: schema.rosterEntry,
        shift: schema.shiftDefinition,
        userName: schema.users.name,
      })
      .from(schema.rosterEntry)
      .innerJoin(schema.shiftDefinition, eq(schema.shiftDefinition.id, schema.rosterEntry.shiftId))
      .innerJoin(schema.users, eq(schema.users.id, schema.rosterEntry.userId))
      .where(
        and(
          sql`${schema.rosterEntry.workDate} BETWEEN ${addDaysToDateKey(today, -1)}::date AND ${addDaysToDateKey(today, 2)}::date`,
          sql`${schema.rosterEntry.userId} <> ${userId}`,
          eq(schema.users.status, 'active'),
        ),
      );
    return rows
      .map((row) => ({
        userId: row.entry.userId,
        name: row.userName,
        shiftName: row.shift.name,
        start: shiftWindow(row.shift, row.entry.workDate, timezone).start,
      }))
      .filter((row) => row.start >= from && row.start <= to)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        shiftName: row.shiftName,
        startsAt: row.start.toISOString(),
      }));
  }

  // --- the outgoing person ---

  /**
   * The AI's draft of the free text of the handoff (T-135): claims, each with the tickets and items it
   * rests on, and the same as lines for the two text boxes. Nothing is saved; the person reads, copies
   * what is right and saves and confirms as usual. `null` when the AI is off, over budget, failing or
   * has nothing to say: the handoff never depends on it (AC-7).
   */
  async aiPrefill(
    principal: Principal,
    locale: AssistantLocale,
  ): Promise<HandoffAiPrefillResponse> {
    const current = await this.current(principal);
    if (current.handoff === null) throw conflict('Start the handoff draft first');
    const block = await this.summaries.claims({
      kind: 'handoff',
      userId: principal.userId,
      locale,
      subject: 'the notes of a shift handoff, written by the person who leaves',
      facts: briefHandoffFacts(
        current.handoff,
        locale,
        await customerNamesOfTickets(
          this.database.db,
          current.handoff.items.flatMap((item) => (item.ticket === null ? [] : [item.ticket.id])),
        ),
      ),
      dataAsOf: this.now(),
      maxClaims: 6,
    });
    if (block === null) return { prefill: null };
    return {
      prefill: {
        ...block,
        notes: block.claims.map((claim) => `- ${claim.text}`).join('\n'),
        messageForNext: joinClaims(block.claims.slice(0, 3)).replaceAll('\n', ' '),
      },
    };
  }

  /**
   * Creates the draft handoff of the open session, or adds to it the open tickets assigned to the
   * caller that it does not list yet (R-7.5 "pre-fill"). Made from data by code, not by an AI. A
   * confirmed handoff is returned as it is. Safe to call again.
   */
  async prefill(principal: Principal): Promise<Handoff> {
    const actor = { type: 'user' as const, id: principal.userId };
    return this.uow.run(async (uow) => {
      const session = await openSessionOf(uow.tx, principal.userId);
      if (session === undefined)
        throw conflict('Clock in first: there is no open shift to hand off');

      let [handoff] = await uow.tx
        .select()
        .from(schema.handoff)
        .where(eq(schema.handoff.sessionId, session.s.id))
        .for('update');
      if (handoff === undefined) {
        [handoff] = await uow.tx
          .insert(schema.handoff)
          .values({ sessionId: session.s.id, fromUserId: principal.userId, updatedAt: this.now() })
          .returning();
      }
      if (handoff === undefined) throw new Error('handoff insert returned nothing');
      if (handoff.status === 'confirmed') return this.reader.view(uow.tx, handoff.id);

      const listed = await uow.tx
        .select({ ticketId: schema.handoffItem.ticketId })
        .from(schema.handoffItem)
        .where(eq(schema.handoffItem.handoffId, handoff.id));
      const listedIds = new Set(
        listed.flatMap((row) => (row.ticketId === null ? [] : [row.ticketId])),
      );
      const open = await uow.tx
        .select({
          id: schema.ticket.id,
          number: schema.ticket.number,
          subject: schema.ticket.subject,
        })
        .from(schema.ticket)
        .where(
          and(
            eq(schema.ticket.assigneeId, principal.userId),
            inArray(schema.ticket.status, [...OPEN_STATUSES]),
          ),
        )
        .orderBy(asc(schema.ticket.priority), asc(schema.ticket.number))
        .limit(200);
      const fresh = open.filter((ticket) => !listedIds.has(ticket.id));
      const carried = await this.reader.carriedBefore(
        uow.tx,
        fresh.map((ticket) => ticket.id),
      );
      const position = listed.length;
      if (fresh.length > 0) {
        await uow.tx.insert(schema.handoffItem).values(
          fresh.map((ticket, index) => ({
            handoffId: handoff.id,
            position: position + index,
            kind: 'pending',
            ticketId: ticket.id,
            title: ticket.subject,
            source: 'prefill',
            requiresAck: itemRequiresAck('pending'),
            carriedShifts: carried.get(ticket.id) ?? 0,
          })),
        );
      }
      await this.audit.recordInTransaction(uow.tx, {
        actor,
        action: AUDIT_ACTIONS.handoffPrefill,
        targetType: 'handoff',
        targetId: handoff.id,
        metadata: { added: fresh.length, sessionId: session.s.id },
      });
      return this.reader.view(uow.tx, handoff.id);
    });
  }

  /** Saves the draft: the whole item list, the incoming person, the free text and the message for the next shift. */
  async save(principal: Principal, handoffId: string, input: SaveHandoff): Promise<Handoff> {
    const actor = { type: 'user' as const, id: principal.userId };
    const attachments =
      input.attachmentIds === undefined
        ? undefined
        : await this.uploads.claim(principal.userId, input.attachmentIds);
    return this.uow.run(async (uow) => {
      await this.ownDraft(uow.tx, principal, handoffId);
      if (input.toUserId !== undefined && input.toUserId !== null) {
        if (input.toUserId === principal.userId)
          throw badRequest('The incoming person cannot be you');
        await translating(() => assertAssignableStaff(uow.tx, [input.toUserId as string]));
      }

      const existing = await uow.tx
        .select()
        .from(schema.handoffItem)
        .where(eq(schema.handoffItem.handoffId, handoffId));
      const byId = new Map(existing.map((item) => [item.id, item]));
      const keep = new Set<string>();
      let added = 0;
      let changed = 0;

      for (const [index, entry] of input.items.entries()) {
        const nextAction = entry.nextAction?.trim() ? entry.nextAction.trim() : null;
        const dueAt =
          entry.dueAt === undefined || entry.dueAt === null ? null : new Date(entry.dueAt);
        const severity = entry.severity?.trim() ? entry.severity.trim() : null;
        if (entry.id !== undefined) {
          const item = byId.get(entry.id);
          if (item === undefined) throw badRequest('An item id does not belong to this handoff');
          if (item.kind !== entry.kind) throw badRequest('The kind of an item cannot change');
          keep.add(item.id);
          const edited =
            item.edited ||
            (item.source === 'prefill' &&
              (item.title !== entry.title || item.severity !== severity));
          const differs =
            item.title !== entry.title ||
            item.nextAction !== nextAction ||
            item.severity !== severity ||
            item.position !== index ||
            (item.dueAt?.getTime() ?? null) !== (dueAt?.getTime() ?? null);
          if (differs) {
            changed += 1;
            await uow.tx
              .update(schema.handoffItem)
              .set({
                title: entry.title,
                nextAction,
                dueAt,
                severity,
                edited,
                position: index,
                updatedAt: this.now(),
              })
              .where(eq(schema.handoffItem.id, item.id));
          }
          continue;
        }

        let ticketId: string | null = null;
        let carried = 0;
        if (entry.kind === 'pending') {
          const [ticket] = await uow.tx
            .select({ id: schema.ticket.id, orgId: schema.ticket.orgId })
            .from(schema.ticket)
            .where(eq(schema.ticket.id, entry.ticketId ?? ''))
            .limit(1);
          if (ticket === undefined) throw badRequest('ticketId does not refer to a ticket');
          // The answer shows the ticket's subject: only someone who may read the ticket gets it.
          assertCanRead(principal);
          assertOrgAccess(principal, ticket.orgId);
          if (existing.some((item) => item.ticketId === ticket.id)) {
            throw conflict('That ticket is already in this handoff');
          }
          ticketId = ticket.id;
          carried = (await this.reader.carriedBefore(uow.tx, [ticket.id])).get(ticket.id) ?? 0;
        }
        added += 1;
        await uow.tx.insert(schema.handoffItem).values({
          handoffId,
          position: index,
          kind: entry.kind,
          ticketId,
          title: entry.title,
          nextAction,
          dueAt,
          severity,
          source: 'manual',
          requiresAck: itemRequiresAck(entry.kind),
          carriedShifts: carried,
        });
      }

      const removed = existing.filter((item) => !keep.has(item.id));
      if (removed.length > 0) {
        await uow.tx.delete(schema.handoffItem).where(
          inArray(
            schema.handoffItem.id,
            removed.map((item) => item.id),
          ),
        );
      }
      await uow.tx
        .update(schema.handoff)
        .set({
          ...(input.toUserId === undefined ? {} : { toUserId: input.toUserId }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ...(input.messageForNext === undefined ? {} : { messageForNext: input.messageForNext }),
          ...(attachments === undefined ? {} : { attachments }),
          updatedAt: this.now(),
        })
        .where(eq(schema.handoff.id, handoffId));

      await this.audit.recordInTransaction(uow.tx, {
        actor,
        action: AUDIT_ACTIONS.handoffSave,
        targetType: 'handoff',
        targetId: handoffId,
        metadata: { items: input.items.length, added, removed: removed.length, changed },
      });
      return this.reader.view(uow.tx, handoffId);
    });
  }

  /**
   * Confirms the handoff (AC-7). Refused with 409 `handoff_incomplete` while an open P1/P2 ticket
   * assigned to the caller is missing or has no next action. The message for the next shift
   * becomes a shift note to everyone on it (R-7.7).
   */
  async confirm(principal: Principal, handoffId: string): Promise<Handoff> {
    const actor = { type: 'user' as const, id: principal.userId };
    return this.uow.run(async (uow) => {
      const handoff = await this.ownDraft(uow.tx, principal, handoffId);
      const items = await uow.tx
        .select({
          kind: schema.handoffItem.kind,
          ticketId: schema.handoffItem.ticketId,
          nextAction: schema.handoffItem.nextAction,
        })
        .from(schema.handoffItem)
        .where(eq(schema.handoffItem.handoffId, handoffId));
      const blockers = handoffBlockers(
        await this.reader.requiredFor(uow.tx, principal.userId, handoff.sessionId),
        items,
      );
      if (blockers.length > 0)
        throw new HandoffIncompleteError({ noConfirmedHandoff: true, blockers });

      const now = this.now();
      await uow.tx
        .update(schema.handoff)
        .set({ status: 'confirmed', confirmedAt: now, updatedAt: now })
        .where(eq(schema.handoff.id, handoffId));
      const message = handoff.messageForNext.trim();
      if (message !== '') {
        await uow.tx.insert(schema.shiftNote).values({
          authorId: principal.userId,
          audience: 'next_shift',
          body: message,
          attachments: handoff.attachments,
          handoffId,
          createdAt: now,
        });
      }
      await this.audit.recordInTransaction(uow.tx, {
        actor,
        action: AUDIT_ACTIONS.handoffConfirm,
        targetType: 'handoff',
        targetId: handoffId,
        metadata: {
          items: items.length,
          pending: items.filter((item) => item.kind === 'pending').length,
          toUserId: handoff.toUserId,
          messageLeft: message !== '',
        },
      });
      return this.reader.view(uow.tx, handoffId);
    });
  }

  /** Back to draft, to add something. Refused once the incoming person has acknowledged an item. */
  async reopen(principal: Principal, handoffId: string): Promise<Handoff> {
    const actor = { type: 'user' as const, id: principal.userId };
    return this.uow.run(async (uow) => {
      const [handoff] = await uow.tx
        .select()
        .from(schema.handoff)
        .where(eq(schema.handoff.id, handoffId))
        .for('update');
      if (handoff?.fromUserId !== principal.userId) throw notFound('No such handoff');
      if (handoff.status !== 'confirmed')
        throw new HandoffLockedError('The handoff is still a draft');
      const session = await openSessionOf(uow.tx, principal.userId);
      if (session?.s.id !== handoff.sessionId) {
        throw new HandoffLockedError('The shift of this handoff has ended');
      }
      const [answered] = await uow.tx
        .select({ id: schema.handoffItem.id })
        .from(schema.handoffItem)
        .where(
          and(
            eq(schema.handoffItem.handoffId, handoffId),
            notInArray(schema.handoffItem.ackStatus, ['pending']),
          ),
        )
        .limit(1);
      if (answered !== undefined) {
        throw new HandoffLockedError(
          'The incoming person has already answered an item; ask a lead to override the clock out instead',
        );
      }
      await uow.tx
        .update(schema.handoff)
        .set({ status: 'draft', confirmedAt: null, updatedAt: this.now() })
        .where(eq(schema.handoff.id, handoffId));
      // The note made from the message goes back with it; confirming makes a new one.
      await uow.tx.delete(schema.shiftNote).where(eq(schema.shiftNote.handoffId, handoffId));
      await this.audit.recordInTransaction(uow.tx, {
        actor,
        action: AUDIT_ACTIONS.handoffReopen,
        targetType: 'handoff',
        targetId: handoffId,
      });
      return this.reader.view(uow.tx, handoffId);
    });
  }

  /** A draft handoff of the caller whose shift is still open; 404 for anyone else's. */
  private async ownDraft(tx: Tx, principal: Principal, handoffId: string) {
    const [handoff] = await tx
      .select()
      .from(schema.handoff)
      .where(eq(schema.handoff.id, handoffId))
      .for('update');
    if (handoff?.fromUserId !== principal.userId) throw notFound('No such handoff');
    if (handoff.status !== 'draft') {
      throw new HandoffLockedError('The handoff is confirmed; reopen it to change it');
    }
    const session = await openSessionOf(tx, principal.userId);
    if (session?.s.id !== handoff.sessionId) {
      throw new HandoffLockedError('The shift of this handoff has ended');
    }
    return handoff;
  }

  // --- the incoming person ---

  /**
   * Accept, reassign or question one item (R-7.6). Accept hands the ticket to the caller;
   * reassign hands it to the person named; a question sends a note to the outgoing person and keeps
   * the item open for an answer. An accepted or reassigned item cannot be answered again.
   */
  async acknowledge(
    principal: Principal,
    itemId: string,
    input: AckHandoffItem,
  ): Promise<AckResult> {
    const actor = { type: 'user' as const, id: principal.userId };
    return this.uow.run(async (uow) => {
      const warnings: AckResult['warnings'] = [];
      const [row] = await uow.tx
        .select({ item: schema.handoffItem, handoff: schema.handoff })
        .from(schema.handoffItem)
        .innerJoin(schema.handoff, eq(schema.handoff.id, schema.handoffItem.handoffId))
        .where(eq(schema.handoffItem.id, itemId))
        .for('update', { of: schema.handoffItem });
      if (row === undefined) throw notFound('No such item');
      const { item, handoff } = row;

      // Only a handoff that was confirmed and is addressed to the caller: the named person, or
      // whoever is clocked in when it names nobody. Anything else looks like a missing item.
      // A handoff is offered for 36 hours, and "clocked in" means on shift (not a session left open
      // for more than 16 hours), the same as in `GET /v1/handoffs/incoming`.
      const onShift = await this.reader.isOnShift(uow.tx, principal.userId);
      const horizon = new Date(this.now().getTime() - HANDOFF_VISIBLE_HOURS * 3_600_000);
      const addressed =
        handoff.status === 'confirmed' &&
        handoff.confirmedAt !== null &&
        handoff.confirmedAt >= horizon &&
        handoff.fromUserId !== principal.userId &&
        (handoff.toUserId === principal.userId || (handoff.toUserId === null && onShift));
      if (!addressed) throw notFound('No such item');
      if (!item.requiresAck)
        throw badRequest('This item is for information; there is nothing to acknowledge');
      if (item.ackStatus === 'accepted' || item.ackStatus === 'reassigned') {
        throw new HandoffLockedError('This item has already been acknowledged');
      }

      let ticketKey: string | null = null;
      if (item.ticketId !== null) {
        const [ticket] = await uow.tx
          .select()
          .from(schema.ticket)
          .where(eq(schema.ticket.id, item.ticketId))
          .limit(1);
        if (ticket === undefined) throw notFound('The ticket of this item no longer exists');
        ticketKey = this.keys.format(ticket.number);
        const stillOpen = (OPEN_STATUSES as readonly string[]).includes(ticket.status);
        // Hand the ticket over only while it still sits with the outgoing person (or nobody): if
        // someone else took it meanwhile, the acknowledgment is recorded and the ticket is left alone.
        const movable =
          stillOpen && (ticket.assigneeId === handoff.fromUserId || ticket.assigneeId === null);
        const target =
          input.decision === 'accept'
            ? principal.userId
            : input.decision === 'reassign'
              ? input.assigneeId
              : undefined;
        if (input.decision === 'reassign' && input.assigneeId !== undefined) {
          // P1 and P2 must go to someone who is on shift; a P3 or P4 may wait for an off-shift
          // colleague, and the answer says so.
          // Not back to the person who just handed it over, even if they clocked in again: the
          // handoff exists because the ticket is leaving their hands (T-125a).
          if (input.assigneeId === handoff.fromUserId) {
            throw badRequest(
              `${ticketKey} was handed over by that person: reassign it to someone else`,
            );
          }
          await translating(() => assertAssignableStaff(uow.tx, [input.assigneeId as string]));
          if (!(await this.reader.isOnShift(uow.tx, input.assigneeId))) {
            if (isHandoffRequiredPriority(ticket.priority)) {
              throw badRequest(
                `${ticketKey} is ${ticket.priority}: reassign it to someone who is clocked in`,
              );
            }
            warnings.push('assignee_off_shift');
          }
        }
        if (target !== undefined && movable && ticket.assigneeId !== target) {
          const result = await translating(() =>
            this.domain.tickets.assign(uow.tx, domainContext(this.domain, actor), {
              ref: ticket.id,
              assignment: { assigneeId: target },
            }),
          );
          settle(uow, result);
        }
      } else if (input.decision === 'reassign') {
        throw badRequest('Only a ticket can be reassigned');
      }

      const now = this.now();
      const status =
        input.decision === 'accept'
          ? 'accepted'
          : input.decision === 'reassign'
            ? 'reassigned'
            : 'question';
      if (input.decision === 'question') {
        await uow.tx.insert(schema.shiftNote).values({
          authorId: principal.userId,
          audience: 'person',
          toUserId: handoff.fromUserId,
          body: `Question about ${ticketKey ?? item.title}: ${input.note ?? ''}`.slice(0, 2000),
          createdAt: now,
        });
      }
      await uow.tx
        .update(schema.handoffItem)
        .set({
          ackStatus: status,
          ackBy: principal.userId,
          ackAt: now,
          ackNote: input.decision === 'question' ? (input.note ?? null) : null,
          updatedAt: now,
        })
        .where(eq(schema.handoffItem.id, itemId));
      await this.audit.recordInTransaction(uow.tx, {
        actor,
        action: AUDIT_ACTIONS.handoffItemAck,
        targetType: 'handoff_item',
        targetId: itemId,
        before: { ackStatus: item.ackStatus },
        after: { ackStatus: status },
        metadata: {
          handoffId: handoff.id,
          decision: input.decision,
          ticketId: item.ticketId,
          ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
        },
      });

      const items = await this.reader.items(uow.tx, [handoff.id]);
      const updated = items.get(handoff.id)?.find((entry) => entry.id === itemId);
      if (updated === undefined) throw new Error('item vanished');
      return { ...updated, warnings };
    });
  }
}
