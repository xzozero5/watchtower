import { orgScopeCondition, schema } from '@watchtower/db';
import {
  OPEN_STATUSES,
  TICKET_PRIORITIES,
  type InsightFact,
  type InsightFactsResult,
  type OrgScope,
} from '@watchtower/shared';
import { eq, inArray } from 'drizzle-orm';

import { readTicketStats } from '../tickets/sla-stats.js';
import { finishFacts, metric, state, type InsightBuildOptions } from './facts.js';

export interface MyWorkOptions extends InsightBuildOptions {
  /** The person the element is about: the only one who may read it. The caller settled that. */
  readonly subjectUserId: string;
  readonly scope?: OrgScope;
}

/**
 * `home.my_work` (mode F, scope `user`, computed when the page is read): the open tickets one person holds
 * and how many of them are close to or past SLA, by priority. The numbers are the ones
 * `GET /v1/tickets/stats?assignee=me` gives (same reader). Only that person's own ref appears (`self`);
 * subjects, requesters and tags are free text and stay out.
 */
export async function buildMyWorkFacts(options: MyWorkOptions): Promise<InsightFactsResult> {
  const { executor, subjectUserId } = options;
  const now = options.now ?? new Date();
  const stats = await readTicketStats(
    executor,
    [
      orgScopeCondition(schema.ticket.orgId, options.scope ?? { kind: 'all' }),
      inArray(schema.ticket.status, [...OPEN_STATUSES]),
      eq(schema.ticket.assigneeId, subjectUserId),
    ],
    now,
  );
  const self = { kind: 'user' as const, id: subjectUserId };
  const total = stats.total;
  const facts: InsightFact[] = [
    metric(
      'open',
      total.open,
      {
        th: `คุณถืออยู่ ${String(total.open)} รายการ`,
        en: `You hold ${String(total.open)} items`,
      },
      self,
    ),
    metric('at_risk', total.sla.at_risk, {
      th: `${String(total.sla.at_risk)} รายการใกล้ผิด SLA`,
      en: `${String(total.sla.at_risk)} close to breaching SLA`,
    }),
    metric('breached', total.sla.breached, {
      th: `${String(total.sla.breached)} รายการผิด SLA แล้ว`,
      en: `${String(total.sla.breached)} already past SLA`,
    }),
    metric('paused', total.sla.paused, {
      th: `${String(total.sla.paused)} รายการหยุดนาฬิกา SLA`,
      en: `${String(total.sla.paused)} with the SLA clock paused`,
    }),
  ];
  for (const priority of TICKET_PRIORITIES) {
    const bucket = stats.byPriority.find((entry) => entry.priority === priority);
    const open = bucket?.open ?? 0;
    facts.push(
      metric(`open_${priority.toLowerCase()}`, open, {
        th: `${priority} ที่ถืออยู่ ${String(open)} รายการ`,
        en: `${String(open)} ${priority} items held`,
      }),
    );
  }
  facts.push(
    state(
      'my_work_state',
      total.sla.breached > 0
        ? 'breached'
        : total.sla.at_risk > 0
          ? 'at_risk'
          : total.open > 0
            ? 'ok'
            : 'clear',
      { th: 'สถานะงานของคุณ', en: 'State of your work' },
    ),
  );
  return finishFacts(facts, now, options.view);
}
