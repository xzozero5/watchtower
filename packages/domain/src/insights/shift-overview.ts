import { orgScopeCondition, schema } from '@watchtower/db';
import { OPEN_STATUSES, type InsightFact, type InsightFactsResult } from '@watchtower/shared';
import { inArray } from 'drizzle-orm';

import { readShiftOverview } from '../shifts/overview.js';
import { readTicketStats } from '../tickets/sla-stats.js';
import { finishFacts, metric, state, type InsightBuildOptions } from './facts.js';

/** At most this many people get their own facts; the team facts cover the rest. */
export const SHIFT_OVERVIEW_MAX_PERSONS = 8;

const LETTERS = 'abcdefgh';

/**
 * `shift.overview` (section 9.9): who is on shift, who did not show up, what the incoming shift has not
 * acknowledged, and for each person on the page the number of open tickets they hold and how many are close
 * to or past SLA.
 *
 * People are refs and placeholders only (`{person_a}` with a `user` ref): no name, e-mail or phone reaches a
 * fact, and the persons come in the order of their user ids, never by workload, so the facts themselves
 * carry no ranking. The handoff item titles and the questions are staff free text and are only counted.
 */
export async function buildShiftOverviewFacts(
  options: InsightBuildOptions & { readonly ticketKey?: (number: number) => string },
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();
  const overview = await readShiftOverview(executor, {
    now,
    ticketKey: options.ticketKey ?? ((number) => String(number)),
  });

  const onShiftIds = [...new Set(overview.onShift.map((session) => session.userId))];
  const noShowIds = [...new Set(overview.noShows.map((entry) => entry.userId))];
  const persons = [...new Set([...onShiftIds, ...noShowIds])]
    .sort()
    .slice(0, SHIFT_OVERVIEW_MAX_PERSONS);

  const stats =
    persons.length === 0
      ? undefined
      : await readTicketStats(
          executor,
          [
            inArray(schema.ticket.status, [...OPEN_STATUSES]),
            inArray(schema.ticket.assigneeId, persons),
            orgScopeCondition(schema.ticket.orgId, { kind: 'all' }),
          ],
          now,
        );

  const late = overview.onShift.filter((session) => session.late).length;
  const facts: InsightFact[] = [
    metric('on_shift', onShiftIds.length, {
      th: `อยู่ในกะ ${String(onShiftIds.length)} คน`,
      en: `${String(onShiftIds.length)} people on shift`,
    }),
    metric('late', late, {
      th: `เข้ากะสาย ${String(late)} คน`,
      en: `${String(late)} clocked in late`,
    }),
    metric('no_shows', overview.noShows.length, {
      th: `ไม่มาตามตาราง ${String(overview.noShows.length)} คน`,
      en: `${String(overview.noShows.length)} rostered but not clocked in`,
    }),
    metric('unack_count', overview.unacknowledged.count, {
      th: `รายการส่งต่อที่ยังไม่รับทราบ ${String(overview.unacknowledged.count)} รายการ`,
      en: `${String(overview.unacknowledged.count)} handoff items not acknowledged`,
    }),
    metric('unack_overdue', overview.unacknowledged.overdue, {
      th: `ในนั้นเกินเวลา ${String(overview.unacknowledged.overdue)} รายการ`,
      en: `${String(overview.unacknowledged.overdue)} of them overdue`,
    }),
    metric('open_questions', overview.openQuestions, {
      th: `คำถามที่ยังไม่มีคำตอบ ${String(overview.openQuestions)} รายการ`,
      en: `${String(overview.openQuestions)} open questions`,
    }),
    metric('questions_overdue', overview.questions.overdue, {
      th: `คำถามของ ticket P1/P2 ที่เกินเวลา ${String(overview.questions.overdue)} รายการ`,
      en: `${String(overview.questions.overdue)} P1/P2 questions overdue`,
    }),
    state(
      'handoff_state',
      overview.unacknowledged.overdue > 0 || overview.questions.overdue > 0
        ? 'overdue'
        : overview.unacknowledged.count > 0 || overview.openQuestions > 0
          ? 'pending'
          : 'clear',
      { th: 'สถานะการส่งต่อกะ', en: 'Shift handoff state' },
    ),
  ];

  persons.forEach((userId, index) => {
    const letter = LETTERS[index];
    if (letter === undefined) return;
    const placeholder = `{person_${letter}}`;
    const ref = { kind: 'user' as const, id: userId };
    const bucket = stats?.byAssignee.find((entry) => entry.assigneeId === userId);
    const held = bucket?.open ?? 0;
    const risk = (bucket?.sla.at_risk ?? 0) + (bucket?.sla.breached ?? 0);
    const status = onShiftIds.includes(userId)
      ? overview.onShift.some((session) => session.userId === userId && session.late)
        ? 'late'
        : 'on_shift'
      : 'no_show';
    facts.push(
      state(
        `person_${letter}_status`,
        status,
        {
          th: `${placeholder} สถานะกะ: ${status}`,
          en: `${placeholder} shift status: ${status}`,
        },
        ref,
      ),
      metric(
        `person_${letter}_held`,
        held,
        {
          th: `${placeholder} ถือ ${String(held)} รายการ`,
          en: `${placeholder} holds ${String(held)} open tickets`,
        },
        ref,
      ),
      metric(
        `person_${letter}_risk`,
        risk,
        {
          th: `${placeholder} มี ${String(risk)} รายการใกล้หรือผิด SLA`,
          en: `${placeholder} has ${String(risk)} tickets close to or past SLA`,
        },
        ref,
      ),
    );
  });
  return finishFacts(facts, now, options.view);
}
