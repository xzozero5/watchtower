import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  claimSchema,
  detectLanguage,
  scrubGoldenIdentifiers,
  ticketGradeViolationSchema,
  type Claim,
  type GoldenAnswer,
  type TicketGrade,
  type TicketGradeViolation,
} from '@watchtower/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { DATABASE } from '../database/database.module.js';
import { MASKED_TEXT_UNAVAILABLE, type MaskingSession } from '../masking/pii-masker.js';
import { TICKET_KEYS, type TicketKeys } from '../tickets/ticket-keys.js';
import { TicketReader, isMasked } from '../tickets/ticket-reader.js';

/** Delivery states of a reply a customer has, or is about to have, in front of them. A failed or cancelled one was never sent. */
const SENT_DELIVERY = ['delivered', 'not_applicable', 'pending'] as const;

const maskHref = (href: string | undefined): { href?: string } =>
  href !== undefined && href.startsWith('/') && !href.startsWith('//') ? { href } : {};

function maskClaim(claim: Claim, session: MaskingSession): Claim {
  return {
    ...claim,
    text: session.text(claim.text),
    evidence: claim.evidence.map(({ href, ...chip }) => ({
      ...chip,
      label: session.text(chip.label),
      ...maskHref(href),
    })),
  };
}

/** Golden answers (T-302a) and the grade of a ticket (T-301d). */
@Injectable()
export class GoldenService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(TicketReader) private readonly tickets: TicketReader,
    @Inject(TICKET_KEYS) private readonly keys: TicketKeys,
  ) {}

  /** The grade of the latest resolution of a ticket, or null while the grader has not looked at it. */
  async gradeOf(
    ref: string,
    principal: Principal,
  ): Promise<{ ticketId: string; grade: TicketGrade | null }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    const [row] = await this.database.db
      .select()
      .from(schema.aiResolutionGrade)
      .where(eq(schema.aiResolutionGrade.ticketId, ticket.t.id))
      .orderBy(desc(schema.aiResolutionGrade.cycle))
      .limit(1);
    if (row === undefined) return { ticketId: ticket.t.id, grade: null };

    // A row the contract cannot read is dropped, never shown half-true (N5).
    const reasons: Claim[] = [];
    for (const item of Array.isArray(row.reasoning) ? row.reasoning : []) {
      const parsed = claimSchema.safeParse(item);
      if (parsed.success) reasons.push(parsed.data);
    }
    const violations: TicketGradeViolation[] = [];
    for (const item of Array.isArray(row.policyViolations) ? row.policyViolations : []) {
      const parsed = ticketGradeViolationSchema.safeParse(item);
      if (parsed.success) violations.push(parsed.data);
    }
    const session = isMasked(principal)
      ? await this.tickets.maskingFor(ticket.t.id, [ticket])
      : null;
    const hide = (claim: Claim): Claim => (session === null ? claim : maskClaim(claim, session));
    const grade: TicketGrade = {
      resolutionClass: row.resolutionClass as TicketGrade['resolutionClass'],
      reasons: reasons.map(hide),
      draftVerdict: row.draftVerdict as TicketGrade['draftVerdict'],
      draftQuality: row.draftQuality,
      violations: violations.map((violation) => {
        const { text, evidence } = hide({
          text: violation.text,
          evidence: violation.evidence,
          uncited: violation.uncited,
        });
        return { ...violation, text, evidence };
      }),
      kbGap: row.kbGap,
      intentKey: row.intentKey,
      csat: row.csatScore === null ? null : { score: row.csatScore, resolved: row.csatResolved },
      mock: row.mock,
      gradedAt: row.gradedAt.toISOString(),
    };
    return { ticketId: ticket.t.id, grade };
  }

  /**
   * Keeps a sent reply as a golden answer of the ticket's intent. The text is redacted here with the same
   * redactor that runs before the LLM (N4); the original is not stored. If the redactor refuses the text
   * (too long, too many names) nothing is stored: a golden answer is never the unredacted text.
   */
  async mark(
    ref: string,
    messageId: string,
    principal: Principal,
    shareable = false,
  ): Promise<{ ticketId: string; golden: GoldenAnswer }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    if (ticket.t.intentId === null) {
      throw conflict('Set the intent of the ticket before marking a reply as golden');
    }
    const [message] = await this.database.db
      .select({
        id: schema.message.id,
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        delivery: schema.message.deliveryStatus,
        text: schema.message.bodyText,
      })
      .from(schema.message)
      .where(and(eq(schema.message.id, messageId), eq(schema.message.ticketId, ticket.t.id)))
      .limit(1);
    if (message === undefined) throw notFound('No such message on this ticket');
    if (
      message.direction !== 'outbound' ||
      message.visibility !== 'public' ||
      !(SENT_DELIVERY as readonly string[]).includes(message.delivery)
    ) {
      throw badRequest('Only a reply that was sent to the customer can be marked as golden');
    }
    const session = await this.tickets.maskingFor(ticket.t.id, [ticket]);
    // The PII redactor takes people; the name of the organization, contract numbers and amounts go here (C-8).
    const orgNames = await this.orgNames(ticket.t.orgId);
    const redacted = scrubGoldenIdentifiers(session.text(message.text), orgNames).trim();
    if (redacted === '' || redacted === MASKED_TEXT_UNAVAILABLE) {
      throw badRequest('This reply cannot be redacted safely, so it cannot be kept');
    }
    const language = detectLanguage(message.text);
    const [existing] = await this.database.db
      .select({ id: schema.goldenAnswer.id })
      .from(schema.goldenAnswer)
      .where(
        and(eq(schema.goldenAnswer.messageId, message.id), isNull(schema.goldenAnswer.deletedAt)),
      )
      .limit(1);
    if (existing !== undefined) throw conflict('This reply is already a golden answer');
    const [row] = await this.database.db
      .insert(schema.goldenAnswer)
      .values({
        ticketId: ticket.t.id,
        messageId: message.id,
        intentId: ticket.t.intentId,
        bodyRedacted: redacted,
        language,
        shareable,
        createdBy: principal.userId,
      })
      .returning({ id: schema.goldenAnswer.id });
    if (row === undefined) throw conflict('Could not keep this reply');
    const [golden] = await this.list({ ids: [row.id] });
    if (golden === undefined) throw conflict('Could not keep this reply');
    return { ticketId: ticket.t.id, golden };
  }

  /** The names an organization is known by (its name and its mail domains), for the scrub of a golden answer. */
  private async orgNames(orgId: string | null): Promise<string[]> {
    if (orgId === null) return [];
    const [org] = await this.database.db
      .select({ name: schema.organization.name, domains: schema.organization.domains })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .limit(1);
    return org === undefined ? [] : [org.name, ...org.domains];
  }

  /** The golden answers kept from one ticket (so the web can show which replies are marked). */
  async ofTicket(
    ref: string,
    principal: Principal,
  ): Promise<{ ticketId: string; items: GoldenAnswer[] }> {
    const ticket = await this.tickets.viewRow(ref, principal);
    return { ticketId: ticket.t.id, items: await this.list({ ticketId: ticket.t.id }) };
  }

  async list(filter: {
    ids?: readonly string[];
    ticketId?: string;
    intentKey?: string;
    limit?: number;
  }): Promise<GoldenAnswer[]> {
    const rows = await this.database.db
      .select({
        id: schema.goldenAnswer.id,
        ticketId: schema.goldenAnswer.ticketId,
        number: schema.ticket.number,
        messageId: schema.goldenAnswer.messageId,
        intentKey: schema.intent.key,
        intentName: schema.intent.name,
        text: schema.goldenAnswer.bodyRedacted,
        language: schema.goldenAnswer.language,
        createdById: schema.goldenAnswer.createdBy,
        createdByName: schema.users.name,
        createdAt: schema.goldenAnswer.createdAt,
      })
      .from(schema.goldenAnswer)
      .innerJoin(schema.ticket, eq(schema.ticket.id, schema.goldenAnswer.ticketId))
      .innerJoin(schema.intent, eq(schema.intent.id, schema.goldenAnswer.intentId))
      .leftJoin(schema.users, eq(schema.users.id, schema.goldenAnswer.createdBy))
      .where(
        and(
          isNull(schema.goldenAnswer.deletedAt),
          filter.ids === undefined ? undefined : inArray(schema.goldenAnswer.id, [...filter.ids]),
          filter.ticketId === undefined
            ? undefined
            : eq(schema.goldenAnswer.ticketId, filter.ticketId),
          filter.intentKey === undefined ? undefined : eq(schema.intent.key, filter.intentKey),
        ),
      )
      .orderBy(desc(schema.goldenAnswer.createdAt))
      .limit(filter.limit ?? 200);
    return rows.map((row) => ({
      id: row.id,
      ticketId: row.ticketId,
      ticketKey: this.keys.format(row.number),
      messageId: row.messageId,
      intent: { key: row.intentKey, name: row.intentName },
      text: row.text,
      language: row.language === 'th' || row.language === 'en' ? row.language : null,
      createdBy:
        row.createdByName === null ? null : { id: row.createdById, name: row.createdByName },
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Soft delete. 404 when it does not exist or is already gone. */
  async remove(id: string, principal: Principal): Promise<{ id: string; ticketId: string }> {
    const [row] = await this.database.db
      .update(schema.goldenAnswer)
      .set({ deletedAt: new Date(), deletedBy: principal.userId })
      .where(and(eq(schema.goldenAnswer.id, id), isNull(schema.goldenAnswer.deletedAt)))
      .returning({ id: schema.goldenAnswer.id, ticketId: schema.goldenAnswer.ticketId });
    if (row === undefined) throw notFound('No such golden answer');
    return row;
  }
}
