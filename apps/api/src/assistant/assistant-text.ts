import type { AssistantLocale, SlaState, TicketStatus } from '@watchtower/shared';

/**
 * The words the server itself writes into facts, cards and notes, in the language of the screen
 * (TH/EN). A model (or the mock) that rephrases these facts then answers in the same language. Only
 * what the server states lives here; a model's own sentences follow the `language:` line of the
 * prompt.
 */

const STATUS: Readonly<Record<AssistantLocale, Readonly<Record<string, string>>>> = {
  en: {
    new: 'new',
    triage: 'triage',
    open: 'open',
    waiting_on_customer: 'waiting on the customer',
    waiting_on_dev: 'waiting on a developer',
    resolved: 'resolved',
    closed: 'closed',
    merged: 'merged',
  },
  th: {
    new: 'ใหม่',
    triage: 'รอคัดแยก',
    open: 'เปิดอยู่',
    waiting_on_customer: 'รอลูกค้า',
    waiting_on_dev: 'รอทีมพัฒนา',
    resolved: 'แก้ไขแล้ว',
    closed: 'ปิดแล้ว',
    merged: 'รวมแล้ว',
  },
};

const SLA: Readonly<Record<AssistantLocale, Readonly<Record<SlaState, string>>>> = {
  en: { ok: 'on track', at_risk: 'at risk', breached: 'breached', paused: 'paused' },
  th: { ok: 'ปกติ', at_risk: 'เสี่ยง', breached: 'เกิน SLA แล้ว', paused: 'หยุดนับ' },
};

export function statusWord(locale: AssistantLocale, status: string): string {
  return STATUS[locale][status] ?? status;
}

export function slaWord(locale: AssistantLocale, state: SlaState): string {
  return SLA[locale][state];
}

export interface TicketLine {
  readonly key: string;
  readonly subject: string;
  readonly status: string;
  readonly priority: string;
  readonly assignee: string | null;
  readonly org: string;
  readonly slaState: SlaState | null;
}

export function ticketLine(locale: AssistantLocale, t: TicketLine): string {
  const subject = t.subject;
  const sla = t.slaState === null ? '' : `, SLA ${slaWord(locale, t.slaState)}`;
  const who =
    t.assignee === null
      ? locale === 'th'
        ? 'ยังไม่มีผู้รับผิดชอบ'
        : 'unassigned'
      : locale === 'th'
        ? `ผู้รับผิดชอบ ${t.assignee}`
        : `assigned to ${t.assignee}`;
  return locale === 'th'
    ? `${t.key} "${subject}" ${t.priority} สถานะ${statusWord(locale, t.status)}${sla}, ${who}, ลูกค้า ${t.org}.`
    : `${t.key} "${subject}" ${t.priority}, ${statusWord(locale, t.status)}${sla}, ${who}, customer ${t.org}.`;
}

export function slaLine(
  locale: AssistantLocale,
  input: {
    key: string;
    target: 'first_response' | 'resolution';
    state: SlaState;
    minutesLeft: number | null;
    dueAt: string;
    calendar: 'business' | '24x7';
  },
): string {
  const target =
    locale === 'th'
      ? input.target === 'first_response'
        ? 'ตอบครั้งแรก'
        : 'แก้ไขให้เสร็จ'
      : input.target === 'first_response'
        ? 'first response'
        : 'resolution';
  const left =
    input.minutesLeft === null
      ? locale === 'th'
        ? 'นาฬิกาหยุดอยู่'
        : 'the clock is paused'
      : locale === 'th'
        ? `เหลือ ${String(input.minutesLeft)} นาที`
        : `${String(input.minutesLeft)} minutes left`;
  const cal =
    input.calendar === '24x7'
      ? locale === 'th'
        ? 'นับตลอด 24 ชม.'
        : 'counted 24x7'
      : locale === 'th'
        ? 'นับเฉพาะเวลาทำการ'
        : 'counted in business hours';
  return locale === 'th'
    ? `${input.key} เป้า${target} ${slaWord(locale, input.state)}: ${left} (ครบกำหนด ${input.dueAt}, ${cal}).`
    : `${input.key} ${target} target is ${slaWord(locale, input.state)}: ${left} (due ${input.dueAt}, ${cal}).`;
}

export function loadLine(
  locale: AssistantLocale,
  row: { name: string; open: number; atRisk: number; breached: number; overloaded: boolean },
): string {
  const flag = row.overloaded ? (locale === 'th' ? ' งานล้น' : ' overloaded') : '';
  return locale === 'th'
    ? `${row.name}: ${String(row.open)} งานเปิดอยู่ (เสี่ยง ${String(row.atRisk)}, เกิน SLA ${String(row.breached)})${flag}.`
    : `${row.name}: ${String(row.open)} open tickets (${String(row.atRisk)} at risk, ${String(row.breached)} breached)${flag}.`;
}

export function memberLine(
  locale: AssistantLocale,
  row: { name: string; role: string; onShift: boolean; openTickets: number },
): string {
  const shift =
    locale === 'th'
      ? row.onShift
        ? 'อยู่ในกะ'
        : 'ไม่ได้อยู่ในกะ'
      : row.onShift
        ? 'on shift'
        : 'not on shift';
  return locale === 'th'
    ? `${row.name} (${row.role}) ${shift}, งานเปิดอยู่ ${String(row.openTickets)}.`
    : `${row.name} (${row.role}) is ${shift} with ${String(row.openTickets)} open tickets.`;
}

export const NOTES = {
  noTicket: {
    th: 'ไม่พบ ticket นี้หรือไม่มีสิทธิ์ดู',
    en: 'That ticket was not found, or you cannot see it.',
  },
  couldNot: {
    th: (kind: string, why: string) => `เตรียมการ ${kind} ไม่ได้: ${why}`,
    en: (kind: string, why: string) => `I could not prepare the ${kind} change: ${why}`,
  },
  why: {
    ticket_not_found: {
      th: 'ไม่พบ ticket หรือไม่มีสิทธิ์',
      en: 'the ticket was not found or you cannot see it',
    },
    not_allowed: { th: 'คุณไม่มีสิทธิ์ทำสิ่งนี้', en: 'you do not have access to this' },
    assignee_not_found: { th: 'ไม่พบผู้รับผิดชอบที่ว่า', en: 'no matching person' },
    assignee_ambiguous: {
      th: 'มีหลายคนที่ตรงกัน ระบุให้ชัดขึ้น',
      en: 'several people match; be more specific',
    },
    org_not_found: { th: 'ไม่พบองค์กรที่ว่า', en: 'no matching organization' },
    org_ambiguous: { th: 'มีหลายองค์กรที่ตรงกัน', en: 'several organizations match' },
    invalid: { th: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง', en: 'the details are missing or not valid' },
    no_intent: {
      th: 'ตั้ง intent ของ ticket ก่อนจึงจะร่างคำตอบได้',
      en: 'set the intent of the ticket before asking for a draft',
    },
    needs_note: {
      th: 'การส่งให้ทีมพัฒนาหรือรับกลับต้องมีโน้ต (เหตุผล) ระบุมาด้วย',
      en: 'handing a ticket to a developer, or back, needs a note: give the reason',
    },
    no_change: { th: 'ไม่มีอะไรเปลี่ยน', en: 'nothing would change' },
    transition: {
      th: 'เปลี่ยนเป็นสถานะนั้นไม่ได้จากสถานะปัจจุบัน',
      en: 'that status is not allowed from the current one',
    },
  },
} as const;

export type ProposalWhy = keyof typeof NOTES.why;

export function statusLabelFor(locale: AssistantLocale, status: TicketStatus): string {
  return statusWord(locale, status);
}
