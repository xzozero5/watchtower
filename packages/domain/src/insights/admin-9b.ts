import { schema } from '@watchtower/db';
import { type InsightFact, type InsightFactsResult } from '@watchtower/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { finishFacts, metric, state, type InsightBuildOptions } from './facts.js';

export interface AdminIntentOptions extends InsightBuildOptions {
  readonly intentId: string;
}

/**
 * `admin.intents` (mode F, scope `intent`, adminFactsOnly): administrative facts
 * for an intent: stage, 28-day volume, and procedure publication state. Never advises promotion (N3).
 */
export async function buildAdminIntentsFacts(
  options: AdminIntentOptions,
): Promise<InsightFactsResult> {
  const { executor, intentId } = options;
  const now = options.now ?? new Date();
  const since28d = new Date(now.getTime() - 28 * 86_400_000);

  const [intentRow, tickets28dRow] = await Promise.all([
    executor
      .select({
        id: schema.intent.id,
        autonomyStage: schema.intent.autonomyStage,
        isActive: schema.intent.isActive,
        procedureVersionId: schema.intent.procedureVersionId,
      })
      .from(schema.intent)
      .where(eq(schema.intent.id, intentId))
      .limit(1),
    executor
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.ticket)
      .where(
        and(
          eq(schema.ticket.intentId, intentId),
          sql`${schema.ticket.createdAt} >= ${since28d.toISOString()}::timestamptz`,
        ),
      ),
  ]);

  const targetIntent = intentRow[0];
  if (!targetIntent) {
    throw new Error(`Intent not found: ${intentId}`);
  }

  let procedureStatus = 'none';
  if (targetIntent.procedureVersionId) {
    const [procRow] = await executor
      .select({ status: schema.procedureVersion.status })
      .from(schema.procedureVersion)
      .where(eq(schema.procedureVersion.id, targetIntent.procedureVersionId))
      .limit(1);
    if (procRow) procedureStatus = procRow.status;
  }

  const tickets28d = tickets28dRow[0]?.count ?? 0;
  const intentRef = { kind: 'intent' as const, id: targetIntent.id };

  const facts: InsightFact[] = [
    metric(
      'autonomy_stage',
      targetIntent.autonomyStage,
      {
        th: `Autonomy stage ${String(targetIntent.autonomyStage)}`,
        en: `Autonomy stage ${String(targetIntent.autonomyStage)}`,
      },
      intentRef,
    ),
    metric('tickets_28d', tickets28d, {
      th: `Ticket ใน 28 วันล่าสุด ${String(tickets28d)} รายการ`,
      en: `${String(tickets28d)} tickets in last 28 days`,
    }),
    state('procedure_status', procedureStatus, {
      th: `สถานะ Procedure: ${procedureStatus}`,
      en: `Procedure status is ${procedureStatus}`,
    }),
    state('intent_active', targetIntent.isActive ? 'active' : 'inactive', {
      th: targetIntent.isActive ? 'เปิดใช้งานอยู่' : 'ปิดใช้งาน',
      en: targetIntent.isActive ? 'Active' : 'Inactive',
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `admin.intent.gate` (mode F, scope `intent`, adminFactsOnly): latest gate report facts
 * for an intent: criteria pass/fail/unknown counts. Strictly factual without leading suggestions (N3).
 */
export async function buildAdminIntentGateFacts(
  options: AdminIntentOptions,
): Promise<InsightFactsResult> {
  const { executor, intentId } = options;
  const now = options.now ?? new Date();

  const [reportRow] = await executor
    .select({
      id: schema.autonomyGateReport.id,
      status: schema.autonomyGateReport.status,
      criteria: schema.autonomyGateReport.criteria,
      generatedAt: schema.autonomyGateReport.generatedAt,
    })
    .from(schema.autonomyGateReport)
    .where(eq(schema.autonomyGateReport.intentId, intentId))
    .orderBy(desc(schema.autonomyGateReport.generatedAt))
    .limit(1);

  const report = reportRow;
  const intentRef = { kind: 'intent' as const, id: intentId };

  if (!report) {
    const facts: InsightFact[] = [
      state(
        'gate_status',
        'none',
        {
          th: 'ยังไม่มีรายงาน Gate Report',
          en: 'No gate report recorded yet',
        },
        intentRef,
      ),
      metric('criteria_pass', 0, {
        th: 'ผ่าน 0 เกณฑ์',
        en: '0 criteria passed',
      }),
      metric('criteria_fail', 0, {
        th: 'ไม่ผ่าน 0 เกณฑ์',
        en: '0 criteria failed',
      }),
    ];
    return finishFacts(facts, now, options.view);
  }

  const criteria = Array.isArray(report.criteria) ? report.criteria : [];
  const passCount = criteria.filter((c) => c.pass === true).length;
  const failCount = criteria.filter((c) => c.pass === false).length;
  const unknownCount = criteria.length - passCount - failCount;

  const facts: InsightFact[] = [
    state(
      'gate_status',
      report.status,
      {
        th: `สถานะ Gate Report: ${report.status}`,
        en: `Gate report status is ${report.status}`,
      },
      intentRef,
    ),
    metric('criteria_pass', passCount, {
      th: `ผ่าน ${String(passCount)} เกณฑ์`,
      en: `${String(passCount)} criteria passed`,
    }),
    metric('criteria_fail', failCount, {
      th: `ไม่ผ่าน ${String(failCount)} เกณฑ์`,
      en: `${String(failCount)} criteria failed`,
    }),
    metric('criteria_unknown', unknownCount, {
      th: `ข้อมูลยังไม่เพียงพอ ${String(unknownCount)} เกณฑ์`,
      en: `${String(unknownCount)} criteria with insufficient data`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `admin.ai` (mode F, scope `instance`, adminFactsOnly): AI global safety switches
 * and today's usage telemetry (tokens and USD cost).
 */
export async function buildAdminAiFacts(options: InsightBuildOptions): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [switchesRows, usageTodayRow] = await Promise.all([
    executor
      .select({
        key: schema.aiSwitch.key,
        isOn: schema.aiSwitch.isOn,
      })
      .from(schema.aiSwitch)
      .where(inArray(schema.aiSwitch.key, ['ai_kill_switch', 'ai_stage_cap_pinned'])),
    executor
      .select({
        tokens: sql<number>`coalesce(sum(${schema.aiRun.inputTokens} + ${schema.aiRun.outputTokens}), 0)::int`,
        cost: sql<string | null>`coalesce(sum(${schema.aiRun.costUsd}), 0)::numeric(10, 4)`,
      })
      .from(schema.aiRun)
      .where(sql`${schema.aiRun.createdAt} >= date_trunc('day', now() AT TIME ZONE 'UTC')`),
  ]);

  const killSwitch = switchesRows.find((s) => s.key === 'ai_kill_switch')?.isOn ?? false;
  const capPinned = switchesRows.find((s) => s.key === 'ai_stage_cap_pinned')?.isOn ?? false;
  const tokensToday = usageTodayRow[0]?.tokens ?? 0;
  const costToday = Number(usageTodayRow[0]?.cost ?? 0);

  const facts: InsightFact[] = [
    state('kill_switch', killSwitch ? 'enabled' : 'disabled', {
      th: killSwitch ? 'Kill switch เปิดอยู่' : 'Kill switch ปิดอยู่',
      en: killSwitch ? 'Kill switch is active' : 'Kill switch is inactive',
    }),
    state('cap_pinned', capPinned ? 'enabled' : 'disabled', {
      th: capPinned ? 'Stage cap ถูกตรึงไว้' : 'Stage cap ไม่ถูกตรึง',
      en: capPinned ? 'Stage cap is pinned' : 'Stage cap is unpinned',
    }),
    metric('tokens_today', tokensToday, {
      th: `การใช้งานวันนี้ ${String(tokensToday)} tokens`,
      en: `${String(tokensToday)} tokens used today`,
    }),
    metric('cost_today_usd', costToday, {
      th: `ต้นทุนวันนี้ $${String(costToday)} USD`,
      en: `$${String(costToday)} USD cost today`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `admin.integrations` (mode F, scope `instance`, adminFactsOnly): health and active
 * counts of external channel accounts. Strictly never touches encrypted secrets (N1).
 */
export async function buildAdminIntegrationsFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [summary] = await executor
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) FILTER (WHERE ${schema.channelAccount.disabledAt} IS NULL)::int`,
      healthy: sql<number>`count(*) FILTER (WHERE ${schema.channelAccount.disabledAt} IS NULL AND ${schema.channelAccount.health} = 'healthy')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${schema.channelAccount.disabledAt} IS NULL AND ${schema.channelAccount.health} IN ('error', 'degraded'))::int`,
    })
    .from(schema.channelAccount);

  const total = summary?.total ?? 0;
  const active = summary?.active ?? 0;
  const healthy = summary?.healthy ?? 0;
  const error = summary?.error ?? 0;

  const facts: InsightFact[] = [
    metric('total_accounts', total, {
      th: `Integration ทั้งหมด ${String(total)} รายการ`,
      en: `${String(total)} total integration accounts`,
    }),
    metric('active_accounts', active, {
      th: `เปิดใช้งาน ${String(active)} รายการ`,
      en: `${String(active)} active accounts`,
    }),
    metric('healthy_accounts', healthy, {
      th: `สถานะปกติ ${String(healthy)} รายการ`,
      en: `${String(healthy)} healthy accounts`,
    }),
    metric('error_accounts', error, {
      th: `พบปัญหา ${String(error)} รายการ`,
      en: `${String(error)} accounts with errors`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `admin.outbox` (mode F, scope `instance`, adminFactsOnly): pending, failed, and dead-lettered
 * outbox job counts across queues.
 */
export async function buildAdminOutboxFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [summaryRows, queuesCountRow] = await Promise.all([
    executor
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${schema.outbox.status} = 'pending')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${schema.outbox.status} = 'dead' OR ${schema.outbox.attempts} > 3)::int`,
      })
      .from(schema.outbox),
    executor
      .select({
        queues: sql<number>`count(DISTINCT ${schema.outbox.queue})::int`,
      })
      .from(schema.outbox),
  ]);

  const pending = summaryRows[0]?.pending ?? 0;
  const failed = summaryRows[0]?.failed ?? 0;
  const activeQueues = queuesCountRow[0]?.queues ?? 0;

  const facts: InsightFact[] = [
    metric('pending_jobs', pending, {
      th: `Job รอดำเนินการ ${String(pending)} รายการ`,
      en: `${String(pending)} pending outbox jobs`,
    }),
    metric('failed_jobs', failed, {
      th: `Job ล้มเหลว/dead-letter ${String(failed)} รายการ`,
      en: `${String(failed)} failed or dead-letter jobs`,
    }),
    metric('active_queues', activeQueues, {
      th: `คิวที่มีงาน ${String(activeQueues)} คิว`,
      en: `${String(activeQueues)} distinct active queues`,
    }),
  ];

  return finishFacts(facts, now, options.view);
}

/**
 * `admin.queues` (mode F, scope `instance`, adminFactsOnly): operational status of transactional
 * outbox and outbound delivery queues.
 */
export async function buildAdminQueuesFacts(
  options: InsightBuildOptions,
): Promise<InsightFactsResult> {
  const { executor } = options;
  const now = options.now ?? new Date();

  const [outboxRow, outboundRow] = await Promise.all([
    executor
      .select({
        pending: sql<number>`count(*) FILTER (WHERE ${schema.outbox.status} = 'pending')::int`,
      })
      .from(schema.outbox),
    executor
      .select({
        scheduled: sql<number>`count(*) FILTER (WHERE ${schema.outboundDelivery.state} IN ('scheduled', 'sending'))::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${schema.outboundDelivery.state} = 'failed')::int`,
      })
      .from(schema.outboundDelivery),
  ]);

  const outboxPending = outboxRow[0]?.pending ?? 0;
  const outboundScheduled = outboundRow[0]?.scheduled ?? 0;
  const outboundFailed = outboundRow[0]?.failed ?? 0;

  const facts: InsightFact[] = [
    metric('outbox_pending', outboxPending, {
      th: `Outbox รอดำเนินการ ${String(outboxPending)} รายการ`,
      en: `${String(outboxPending)} outbox jobs pending`,
    }),
    metric('outbound_scheduled', outboundScheduled, {
      th: `Outbound รอส่ง ${String(outboundScheduled)} รายการ`,
      en: `${String(outboundScheduled)} outbound messages scheduled`,
    }),
    metric('outbound_failed', outboundFailed, {
      th: `Outbound ส่งไม่สำเร็จ ${String(outboundFailed)} รายการ`,
      en: `${String(outboundFailed)} outbound deliveries failed`,
    }),
    state('queues_state', outboxPending > 100 || outboundFailed > 0 ? 'warning' : 'healthy', {
      th: 'สถานะคิวงาน',
      en: 'Queues overall state',
    }),
  ];

  return finishFacts(facts, now, options.view);
}
