import { orgScopeCondition, schema } from '@watchtower/db';
import {
  OPEN_STATUSES,
  type InsightFact,
  type InsightFactsResult,
  type OrgScope,
} from '@watchtower/shared';
import { eq, inArray, isNull, sql } from 'drizzle-orm';

import { readTicketStats } from '../tickets/sla-stats.js';
import { finishFacts, metric, state, type InsightBuildOptions } from './facts.js';

export interface QueueListOptions extends InsightBuildOptions {
  readonly subjectUserId: string;
  readonly scope?: OrgScope;
}

/**
 * `home.status` (mode F, scope `instance`): summary of autonomy stages and active intents
 * from the database, plus the state of the AI kill switch.
 */
export async function buildHomeStatusFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [intentsSummary] = await executor
    .select({
      active: sql<number>`count(*) FILTER (WHERE ${schema.intent.isActive} = true)::int`,
      stage2: sql<number>`count(*) FILTER (WHERE ${schema.intent.isActive} = true AND ${schema.intent.autonomyStage} = 2)::int`,
      stage3: sql<number>`count(*) FILTER (WHERE ${schema.intent.isActive} = true AND ${schema.intent.autonomyStage} = 3)::int`,
    })
    .from(schema.intent);

  const [killSwitchRow] = await executor
    .select({ isOn: schema.aiSwitch.isOn })
    .from(schema.aiSwitch)
    .where(eq(schema.aiSwitch.key, 'ai_kill_switch'))
    .limit(1);

  const active = intentsSummary?.active ?? 0;
  const stage2 = intentsSummary?.stage2 ?? 0;
  const stage3 = intentsSummary?.stage3 ?? 0;
  const killSwitchOn = killSwitchRow?.isOn ?? false;

  const facts: InsightFact[] = [
    metric('active_intents', active, {
      th: `Intent ใช้งานอยู่ ${String(active)} รายการ`,
      en: `${String(active)} active intents`,
    }),
    metric('stage_2_intents', stage2, {
      th: `Stage 2 (ตรวจก่อนส่ง) ${String(stage2)} รายการ`,
      en: `${String(stage2)} intents at stage 2`,
    }),
    metric('stage_3_intents', stage3, {
      th: `Stage 3 (ส่งอัตโนมัติ) ${String(stage3)} รายการ`,
      en: `${String(stage3)} intents at stage 3`,
    }),
    state('kill_switch', killSwitchOn ? 'enabled' : 'disabled', {
      th: killSwitchOn
        ? 'Kill switch เปิดอยู่ (AI ถูกระงับ)'
        : 'Kill switch ปิดอยู่ (AI ทำงานปกติ)',
      en: killSwitchOn ? 'Kill switch is active (AI halted)' : 'Kill switch is inactive',
    }),
    state(
      'autonomy_state',
      killSwitchOn ? 'halted' : stage3 > 0 ? 'stage_3_active' : 'stage_2_active',
      {
        th: 'สถานะภาพรวม AI Autonomy',
        en: 'Overall AI autonomy state',
      },
    ),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `queue.list` (mode F, scope `user`): counts of tickets currently open for the viewer
 * and tickets left unassigned, along with SLA at-risk/breached counts. Safe for dev view.
 */
export async function buildQueueListFacts(options: QueueListOptions): Promise<InsightFactsResult> {
  const { executor, subjectUserId } = options;
  const now = options.now ?? new Date();
  const scope = options.scope ?? { kind: 'all' };

  const [myStats, unassignedStats] = await Promise.all([
    readTicketStats(
      executor,
      [
        orgScopeCondition(schema.ticket.orgId, scope),
        inArray(schema.ticket.status, [...OPEN_STATUSES]),
        eq(schema.ticket.assigneeId, subjectUserId),
      ],
      now,
    ),
    readTicketStats(
      executor,
      [
        orgScopeCondition(schema.ticket.orgId, scope),
        inArray(schema.ticket.status, [...OPEN_STATUSES]),
        isNull(schema.ticket.assigneeId),
      ],
      now,
    ),
  ]);

  const selfRef = { kind: 'user' as const, id: subjectUserId };
  const myTotal = myStats.total;
  const unassignedTotal = unassignedStats.total;

  const facts: InsightFact[] = [
    metric(
      'my_open',
      myTotal.open,
      {
        th: `คุณถืออยู่ ${String(myTotal.open)} รายการ`,
        en: `You hold ${String(myTotal.open)} items`,
      },
      selfRef,
    ),
    metric('my_at_risk', myTotal.sla.at_risk, {
      th: `${String(myTotal.sla.at_risk)} รายการที่คุณถือใกล้ผิด SLA`,
      en: `${String(myTotal.sla.at_risk)} items you hold close to breaching SLA`,
    }),
    metric('my_breached', myTotal.sla.breached, {
      th: `${String(myTotal.sla.breached)} รายการที่คุณถือผิด SLA แล้ว`,
      en: `${String(myTotal.sla.breached)} items you hold already past SLA`,
    }),
    metric('unassigned_open', unassignedTotal.open, {
      th: `ยังไม่มอบหมาย ${String(unassignedTotal.open)} รายการ`,
      en: `${String(unassignedTotal.open)} unassigned open items`,
    }),
    metric('unassigned_at_risk', unassignedTotal.sla.at_risk, {
      th: `${String(unassignedTotal.sla.at_risk)} รายการที่ยังไม่มอบหมายใกล้ผิด SLA`,
      en: `${String(unassignedTotal.sla.at_risk)} unassigned items close to breaching SLA`,
    }),
    metric('unassigned_breached', unassignedTotal.sla.breached, {
      th: `${String(unassignedTotal.sla.breached)} รายการที่ยังไม่มอบหมายผิด SLA แล้ว`,
      en: `${String(unassignedTotal.sla.breached)} unassigned items already past SLA`,
    }),
    state(
      'queue_state',
      myTotal.sla.breached > 0 || unassignedTotal.sla.breached > 0
        ? 'breached'
        : myTotal.sla.at_risk > 0 || unassignedTotal.sla.at_risk > 0
          ? 'at_risk'
          : myTotal.open > 0 || unassignedTotal.open > 0
            ? 'active'
            : 'clear',
      {
        th: 'สถานะคิวงาน',
        en: 'Queue state',
      },
    ),
  ];

  return finishFacts(facts, now, options.view);
}
