import { createRedactor, type RedactionSession } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import { detectLanguage } from '@watchtower/shared';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { EvalCase } from './case.js';

type Turn = { from: 'customer' | 'staff' | 'note'; text: string };

/**
 * Text from a past ticket, made safe to keep on disk (N1, N4): the redactor replaces emails, phones,
 * ids and the names it was given, and each placeholder then becomes a plain word in brackets
 * (`(email)`), so an agent that redacts again has nothing left to find or to escape.
 */
export function scrub(session: RedactionSession, text: string): string {
  const redacted: string = session.redact(text);
  return redacted.replaceAll(
    /\[([A-Z][A-Z_]*)_\d+\]/g,
    (_, kind: string) => `(${kind.toLowerCase()})`,
  );
}

export interface ReplayOptions {
  readonly database: Database;
  /** Only tickets resolved in the last N days. */
  readonly days: number;
  readonly limit: number;
}

export interface ReplayExport {
  readonly cases: EvalCase[];
  readonly tickets: number;
  readonly skipped: number;
}

const MAX_TURNS = 30;

/**
 * Builds eval cases from resolved tickets (PRD 6.5: "real anonymized tickets + expected outcome").
 * Per ticket: a classifier case (the label is the intent the ticket ended with, which a person may have
 * set or left as the AI chose `[UNVERIFIED]`), a drafter case (the thread up to the first staff reply,
 * with checks on language and review flags only: no reference answer is a judgement), and a grader
 * case whose expectation is only what the facts allow (verified needs a customer who confirmed).
 * Nothing is read that a person with `ticket.read` could not read, and nothing is written but the file
 * the caller gives the result to.
 */
export async function exportReplay(options: ReplayOptions): Promise<ReplayExport> {
  const db = options.database.db;
  const since = new Date(Date.now() - options.days * 86_400_000);
  const tickets = await db
    .select({
      id: schema.ticket.id,
      number: schema.ticket.number,
      subject: schema.ticket.subject,
      channel: schema.ticket.channel,
      intentId: schema.ticket.intentId,
      requesterContactId: schema.ticket.requesterContactId,
      orgId: schema.ticket.orgId,
    })
    .from(schema.ticket)
    .where(
      and(
        inArray(schema.ticket.status, ['resolved', 'closed']),
        isNotNull(schema.ticket.intentId),
        sql`${schema.ticket.updatedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(schema.ticket.updatedAt))
    .limit(options.limit);

  const intents = await db
    .select({ id: schema.intent.id, key: schema.intent.key, name: schema.intent.name })
    .from(schema.intent)
    .where(eq(schema.intent.isActive, true));
  const staff = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.role, ['agent', 'lead', 'head', 'dev']));

  const cases: EvalCase[] = [];
  let skipped = 0;
  for (const ticket of tickets) {
    const key = intents.find((intent) => intent.id === ticket.intentId)?.key;
    const messages = await db
      .select({
        direction: schema.message.direction,
        visibility: schema.message.visibility,
        text: schema.message.bodyText,
        sender: schema.message.senderContactId,
      })
      .from(schema.message)
      .where(eq(schema.message.ticketId, ticket.id))
      .orderBy(asc(schema.message.createdAt))
      .limit(MAX_TURNS);
    const contactIds = [
      ...new Set(
        [ticket.requesterContactId, ...messages.map((message) => message.sender)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
    const people =
      contactIds.length === 0
        ? []
        : await db
            .select({ name: schema.contact.name })
            .from(schema.contact)
            .where(inArray(schema.contact.id, contactIds));
    const names = [...people.map((person) => person.name), ...staff.map((person) => person.name)];
    const session = createRedactor({ names: () => names }).session({ scope: ticket.id });

    const turns: Turn[] = messages.map((message) => ({
      from:
        message.visibility === 'internal'
          ? 'note'
          : message.direction === 'inbound'
            ? 'customer'
            : 'staff',
      text: scrub(session, message.text),
    }));
    const firstCustomer = turns.find((turn) => turn.from === 'customer');
    if (key === undefined || firstCustomer === undefined) {
      skipped += 1;
      continue;
    }
    const subject = scrub(session, ticket.subject);
    const id = `replay-t${String(ticket.number)}`;
    const language = detectLanguage(firstCustomer.text) === 'th' ? 'th' : 'en';

    cases.push({
      id: `${id}-classifier`,
      agent: 'classifier',
      description: 'Label: the intent the ticket ended with (not independently verified).',
      intent: key,
      input: {
        channel: ticket.channel,
        subject,
        body: firstCustomer.text,
        intents: intents.map((intent) => ({ key: intent.key, name: intent.name })),
      },
      expect: { intentKey: key },
    });

    const firstReply = turns.findIndex((turn) => turn.from === 'staff');
    if (firstReply > 0) {
      cases.push({
        id: `${id}-drafter`,
        agent: 'drafter',
        description:
          'Replay of the thread up to the first staff reply; checks language and review flags.',
        intent: key,
        input: {
          subject,
          turns: turns.slice(0, firstReply).filter((turn) => turn.from !== 'note'),
          intentKey: key,
          customerLanguage: language,
          disclosure: 'restricted',
          evidence: [],
        },
        expect: { language, noReviewFlag: true },
      });
    }

    const [survey] = await db
      .select({
        score: schema.csatSurvey.score,
        resolved: schema.csatSurvey.resolved,
        comment: schema.csatSurvey.comment,
      })
      .from(schema.csatSurvey)
      .where(
        and(eq(schema.csatSurvey.ticketId, ticket.id), eq(schema.csatSurvey.status, 'answered')),
      )
      .limit(1);
    const hasStaff = firstReply !== -1;
    const allowed: ('verified' | 'contained' | 'assumed')[] =
      !hasStaff || survey?.resolved === false
        ? ['assumed']
        : survey?.resolved === true
          ? ['verified', 'contained']
          : ['contained', 'assumed'];
    cases.push({
      id: `${id}-grader`,
      agent: 'grader',
      description: 'Invariants only: the class the facts allow, not a human label.',
      intent: key,
      input: {
        ticketKey: `T${String(ticket.number)}`,
        turns: turns.filter((turn) => turn.from !== 'note'),
        kbCited: false,
        locale: language,
        ...(survey === undefined
          ? {}
          : {
              csat: {
                score: survey.score,
                resolved: survey.resolved,
                ...(survey.comment === null ? {} : { comment: scrub(session, survey.comment) }),
              },
            }),
      },
      expect: { resolutionClassIn: allowed },
    });
  }
  return { cases, tickets: tickets.length, skipped };
}
