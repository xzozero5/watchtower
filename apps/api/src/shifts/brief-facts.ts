import type { ClaimFact } from '@watchtower/ai';
import type {
  AssistantLocale,
  HandoffItem,
  Handoff,
  ShiftBrief,
  SlaState,
} from '@watchtower/shared';

import { BRIEF_HREF, HANDOFF_HREF, NOTES_HREF, ticketHref } from '../assistant/assistant-hrefs.js';
import { slaWord } from '../assistant/assistant-text.js';

/**
 * The facts of a daily brief or a handoff, as text for the summarizer and a chip for the reader (T-135).
 * Built by code from the same data the screen shows, read with the viewer's own access, in the language
 * of the screen, so a summary that rephrases them is in that language too. The order is the order of
 * urgency: the summarizer is told to put the most urgent first and the mock keeps the order it is given.
 * Nothing is here that the viewer could not already see on the page.
 */

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const t = (locale: AssistantLocale, th: string, en: string): string => (locale === 'th' ? th : en);

const MAX_TICKET_FACTS = 5;
const MAX_ITEM_FACTS = 6;

function slaFact(
  locale: AssistantLocale,
  ticket: ShiftBrief['myTickets'][number],
  state: SlaState,
): ClaimFact {
  const left =
    ticket.slaMinutesLeft === null
      ? ''
      : t(
          locale,
          ` เหลือ ${String(ticket.slaMinutesLeft)} นาที`,
          ` with ${String(ticket.slaMinutesLeft)} minutes left`,
        );
  return {
    kind: 'ticket',
    label: ticket.key,
    href: ticketHref(ticket.key),
    text: t(
      locale,
      `${ticket.key} "${cut(ticket.subject, 100)}" (${ticket.priority}) ${slaWord(locale, state)}${left}.`,
      `${ticket.key} "${cut(ticket.subject, 100)}" (${ticket.priority}) is ${slaWord(locale, state)}${left}.`,
    ),
  };
}

function itemFact(locale: AssistantLocale, item: HandoffItem): ClaimFact {
  const kind =
    item.kind === 'incident' || item.kind === 'alert' || item.kind === 'deploy'
      ? item.kind
      : item.kind === 'pending'
        ? ('ticket' as const)
        : ('note' as const);
  const next =
    item.nextAction === null ? '' : ` ${t(locale, 'ถัดไป', 'Next')}: ${cut(item.nextAction, 120)}.`;
  return {
    kind,
    label: cut(item.ticket?.key ?? item.title, 60),
    href: item.ticket === null ? HANDOFF_HREF : ticketHref(item.ticket.key),
    text: `${cut(item.title, 160)}.${next}`,
  };
}

/** The daily brief of a person who is on shift. */
export function briefFacts(
  brief: ShiftBrief,
  locale: AssistantLocale,
  names: readonly string[] = [],
): ClaimFact[] {
  return withNames(buildBriefFacts(brief, locale), names);
}

/** Every fact carries the dictionary, so the redactor knows these people whichever fact it reads (N4). */
function withNames(facts: ClaimFact[], names: readonly string[]): ClaimFact[] {
  return names.length === 0 ? facts : facts.map((fact) => ({ ...fact, names }));
}

function buildBriefFacts(brief: ShiftBrief, locale: AssistantLocale): ClaimFact[] {
  const facts: ClaimFact[] = [];

  // 1. The urgent tickets of the person: breached first, then at risk (the brief is already in that order).
  for (const state of ['breached', 'at_risk'] as const) {
    for (const ticket of brief.myTickets) {
      if (ticket.slaState === state && facts.length < MAX_TICKET_FACTS) {
        facts.push(slaFact(locale, ticket, state));
      }
    }
  }
  // 2. What crossed a shift.
  for (const ticket of brief.carriedOver.slice(0, 3)) {
    facts.push({
      kind: 'ticket',
      label: ticket.key,
      href: ticketHref(ticket.key),
      text: t(
        locale,
        `${ticket.key} "${cut(ticket.subject, 100)}" ค้างมาแล้ว ${String(ticket.crossedShifts)} กะ.`,
        `${ticket.key} "${cut(ticket.subject, 100)}" has carried over ${String(ticket.crossedShifts)} shift(s).`,
      ),
    });
  }
  // 3. The handoff to acknowledge.
  if (brief.handoff.total > 0) {
    facts.push({
      kind: 'handoff',
      label: t(locale, 'ส่งเวร', 'Handoff'),
      href: HANDOFF_HREF,
      text: t(
        locale,
        `รับทราบแล้ว ${String(brief.handoff.acknowledged)} จาก ${String(brief.handoff.total)} รายการที่กะก่อนส่งต่อ.`,
        `${String(brief.handoff.acknowledged)} of ${String(brief.handoff.total)} items from the previous shift are acknowledged.`,
      ),
    });
  }
  // 4. Incidents, alerts, deploys and watch items that the previous shift wrote down.
  for (const item of [
    ...brief.incidents,
    ...brief.snoozedAlerts,
    ...brief.deploys,
    ...brief.watchItems,
  ].slice(0, MAX_ITEM_FACTS)) {
    facts.push(itemFact(locale, item));
  }
  // 5. Notes left for the person.
  if (brief.notes.length > 0) {
    facts.push({
      kind: 'note',
      label: t(locale, 'โน้ตกะ', 'Shift notes'),
      href: NOTES_HREF,
      text: t(
        locale,
        `มีโน้ตกะที่ยังไม่ได้อ่าน ${String(brief.notes.length)} รายการ.`,
        `${String(brief.notes.length)} shift note(s) are unread.`,
      ),
    });
  }
  if (facts.length > 0 && brief.myTickets.length > facts.length) {
    // Where the rest is: the page itself.
    facts.push({
      kind: 'ticket',
      label: t(locale, 'งานของฉัน', 'My tickets'),
      href: BRIEF_HREF,
      text: t(
        locale,
        `ถือ ticket ที่เปิดอยู่ ${String(brief.myTickets.length)} รายการ.`,
        `You hold ${String(brief.myTickets.length)} open tickets.`,
      ),
    });
  }
  return facts;
}

/** The open handoff of the outgoing person: what to write in its free text. */
export function briefHandoffFacts(
  handoff: Handoff,
  locale: AssistantLocale,
  names: readonly string[] = [],
): ClaimFact[] {
  return withNames(buildHandoffFacts(handoff, locale), names);
}

function buildHandoffFacts(handoff: Handoff, locale: AssistantLocale): ClaimFact[] {
  return handoff.items.slice(0, 20).map((item) => {
    const base = itemFact(locale, item);
    const carried =
      item.carriedShifts > 0
        ? t(
            locale,
            ` ค้างมาแล้ว ${String(item.carriedShifts)} กะ.`,
            ` Carried over ${String(item.carriedShifts)} shift(s).`,
          )
        : '';
    const sla =
      item.ticket?.slaState === 'breached' || item.ticket?.slaState === 'at_risk'
        ? ` SLA ${slaWord(locale, item.ticket.slaState)}.`
        : '';
    return { ...base, text: `${base.text}${sla}${carried}` };
  });
}
