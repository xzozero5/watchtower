import { schema, type Database } from '@watchtower/db';
import { evaluateBudget, readAiUsage, readSwitchState, resolveAiCaps } from '@watchtower/domain';
import {
  AUDIT_ACTIONS,
  DEFAULT_ROLE_PERMISSIONS,
  INSIGHT_ELEMENTS,
  isHeadOnlyPermission,
  isPermission,
  WORKSPACE_ROLES,
  type InsightElementKey,
  type Role,
} from '@watchtower/shared';
import { and, eq, gte, sql } from 'drizzle-orm';

import type { WorkerConfig } from '../config.js';
import { INSIGHT_DEFAULTS } from './constants.js';

export interface StandingCheck {
  readonly allowed: boolean;
  readonly killSwitchActive: boolean;
  readonly budgetFull: boolean;
  readonly reason?: string;
}

/**
 * Checks instance-wide gates: kill switch and daily AI budget cap (AC-J10, AC-J22).
 * Layer 1 (App-wide): total app usage compared against caps and INSIGHT_STOP_AT_DAILY_PERCENT.
 */
export async function checkStanding(
  database: Database,
  config: WorkerConfig,
  now: Date = new Date(),
): Promise<StandingCheck> {
  const db = database.db;
  const switches = await readSwitchState(db);
  if (switches.killSwitch) {
    return {
      allowed: false,
      killSwitchActive: true,
      budgetFull: false,
      reason: 'kill switch is active',
    };
  }

  const caps = resolveAiCaps(config);
  const usage = await readAiUsage(db, now);
  const percent = config.INSIGHT_STOP_AT_DAILY_PERCENT / 100;
  const capTokens = Math.floor(caps.dailyTokens * percent);
  const capCostUsd = caps.dailyCostUsd * percent;

  if (
    evaluateBudget(caps, usage).level === 'stop' ||
    usage.tokens >= capTokens ||
    usage.costUsd >= capCostUsd
  ) {
    return {
      allowed: false,
      killSwitchActive: false,
      budgetFull: true,
      reason: `app-wide daily AI budget reached (tokens ${String(usage.tokens)}/${String(capTokens)}, cost ${usage.costUsd.toFixed(2)}/${capCostUsd.toFixed(2)})`,
    };
  }

  return { allowed: true, killSwitchActive: false, budgetFull: false };
}

export interface InsightSpecificBudgetCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Checks insight-specific caps from `config/budgets.yaml` (calls/hour, calls/day, daily tokens, cost).
 * Layer 2 (Narrator-specific): insight_narrator agent usage today <= 30% of caps and INSIGHT_DAILY_TOKENS.
 */
export async function checkInsightSpecificBudget(
  database: Database,
  config: WorkerConfig,
  now: Date = new Date(),
): Promise<InsightSpecificBudgetCheck> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfHour = new Date(now.getTime() - 3600_000);

  const [daily] = await database.db
    .select({
      calls: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${schema.aiRun.inputTokens} + ${schema.aiRun.outputTokens}), 0)::int`,
      cost: sql<string | null>`coalesce(sum(${schema.aiRun.costUsd}), 0)::numeric(10, 4)`,
    })
    .from(schema.aiRun)
    .where(
      and(eq(schema.aiRun.agent, 'insight_narrator'), gte(schema.aiRun.createdAt, startOfDay)),
    );

  const callsToday = daily?.calls ?? 0;
  const tokensToday = daily?.tokens ?? 0;
  const costToday = Number(daily?.cost ?? 0);
  const maxCallsPerDay = config.INSIGHT_CALLS_PER_DAY;
  const caps = resolveAiCaps(config);
  const maxTokensPerDay = Math.min(config.INSIGHT_DAILY_TOKENS, Math.floor(caps.dailyTokens * 0.3));
  const maxCostPerDay = caps.dailyCostUsd * 0.3;

  if (callsToday >= maxCallsPerDay) {
    return {
      allowed: false,
      reason: `insight daily call cap reached (${String(callsToday)}/${String(maxCallsPerDay)})`,
    };
  }
  if (tokensToday >= maxTokensPerDay) {
    return {
      allowed: false,
      reason: `insight daily token cap reached (${String(tokensToday)}/${String(maxTokensPerDay)})`,
    };
  }
  if (costToday >= maxCostPerDay) {
    return {
      allowed: false,
      reason: `insight daily cost cap reached ($${costToday.toFixed(2)}/$${maxCostPerDay.toFixed(2)})`,
    };
  }

  const [hourly] = await database.db
    .select({
      calls: sql<number>`count(*)::int`,
    })
    .from(schema.aiRun)
    .where(
      and(eq(schema.aiRun.agent, 'insight_narrator'), gte(schema.aiRun.createdAt, startOfHour)),
    );

  const callsHour = hourly?.calls ?? 0;
  const maxCallsPerHour = config.INSIGHT_CALLS_PER_HOUR;
  if (callsHour >= maxCallsPerHour) {
    return {
      allowed: false,
      reason: `insight hourly call cap reached (${String(callsHour)}/${String(maxCallsPerHour)})`,
    };
  }

  return { allowed: true };
}

export interface FeedbackGateResult {
  readonly paused: boolean;
  readonly warning: boolean;
  readonly total: number;
  readonly down: number;
  readonly downRate: number;
}

/**
 * Checks 7-day 👎 feedback for an element: >50% (with >=20 votes) pauses narration (AC-J21, R-1).
 */
export async function checkFeedbackGate(
  database: Database,
  element: InsightElementKey,
  now: Date = new Date(),
): Promise<FeedbackGateResult> {
  const windowDays = INSIGHT_DEFAULTS.feedbackWindowDays;
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000);

  const [stats] = await database.db
    .select({
      total: sql<number>`count(*)::int`,
      down: sql<number>`count(*) filter (where ${schema.assistantFeedback.rating} = 'down')::int`,
    })
    .from(schema.assistantFeedback)
    .where(
      and(
        eq(schema.assistantFeedback.targetKind, 'insight'),
        eq(schema.assistantFeedback.element, element),
        gte(schema.assistantFeedback.updatedAt, cutoff),
      ),
    );

  const total = stats?.total ?? 0;
  const down = stats?.down ?? 0;
  const downRate = total === 0 ? 0 : down / total;

  const voteThreshold = INSIGHT_DEFAULTS.feedbackVoteThreshold;
  const pauseRatio = INSIGHT_DEFAULTS.feedbackPauseRatio;
  const warningRatio = INSIGHT_DEFAULTS.feedbackWarningRatio;

  const paused = total >= voteThreshold && downRate > pauseRatio;
  const warning = total >= voteThreshold && downRate > warningRatio;

  return { paused, warning, total, down, downRate };
}

export interface UserScopedBudgetCheck {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Checks budgets for user-scoped narration (`home.my_work`, ADR-029 section 9.4).
 */
export async function checkUserScopedBudget(
  database: Database,
  config: WorkerConfig,
  userId: string,
  now: Date = new Date(),
): Promise<UserScopedBudgetCheck> {
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // 1. Total user-scoped calls today across instance (from audit_log, action = insight.generated, target_type = ai_summary)
  const [instanceCount] = await database.db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, AUDIT_ACTIONS.insightGenerated),
        eq(schema.auditLog.targetType, 'ai_summary'),
        gte(schema.auditLog.createdAt, startOfDay),
      ),
    );

  const instanceTotal = instanceCount?.count ?? 0;
  const maxInstance = config.INSIGHT_USER_SCOPED_CALLS_PER_DAY;
  if (instanceTotal >= maxInstance) {
    return {
      allowed: false,
      reason: `user-scoped daily instance limit reached (${String(instanceTotal)}/${String(maxInstance)})`,
    };
  }

  // 2. Per-user calls today from audit_log
  const [userAuditRow] = await database.db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, AUDIT_ACTIONS.insightGenerated),
        eq(schema.auditLog.targetType, 'ai_summary'),
        sql`${schema.auditLog.metadata}->>'userId' = ${userId}`,
        gte(schema.auditLog.createdAt, startOfDay),
      ),
    );

  const userCallsToday = userAuditRow?.count ?? 0;
  const maxUserCalls = config.INSIGHT_USER_SCOPED_PER_USER_PER_DAY;
  if (userCallsToday >= maxUserCalls) {
    return {
      allowed: false,
      reason: `per-user daily limit reached (${String(userCallsToday)}/${String(maxUserCalls)})`,
    };
  }

  // 3. Min interval across midnight: fetch max(generated_at) WITHOUT startOfDay filter
  const [lastRow] = await database.db
    .select({
      lastGenerated: sql<Date | null>`max(${schema.aiSummary.generatedAt})`,
    })
    .from(schema.aiSummary)
    .where(and(eq(schema.aiSummary.kind, 'my_work'), eq(schema.aiSummary.userId, userId)));

  const minIntervalMs = config.INSIGHT_USER_SCOPED_MIN_INTERVAL_MINUTES * 60_000;
  if (
    lastRow?.lastGenerated &&
    now.getTime() - new Date(lastRow.lastGenerated).getTime() < minIntervalMs
  ) {
    return {
      allowed: false,
      reason: 'per-user min interval not met (generated recently)',
    };
  }

  return { allowed: true };
}

/**
 * Checks whether user exists, is active, unlocked, and still has `ticket.read` permission via DB RBAC.
 */
export async function checkUserAuthorizedForMyWork(
  database: Database,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [user] = await database.db
    .select({
      id: schema.users.id,
      role: schema.users.role,
      status: schema.users.status,
      lockedUntil: schema.users.lockedUntil,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') return false;
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > now.getTime()) {
    return false;
  }
  const role = user.role as Role;
  if (!WORKSPACE_ROLES.includes(role as (typeof WORKSPACE_ROLES)[number])) return false;

  const roleRows = await database.db
    .select({ permission: schema.rolePermissions.permission })
    .from(schema.rolePermissions)
    .where(eq(schema.rolePermissions.role, role));

  let permissions: Set<string>;
  if (roleRows.length > 0) {
    permissions = new Set(
      roleRows
        .filter((r) => isPermission(r.permission))
        .filter((r) => !isHeadOnlyPermission(r.permission) || role === 'head')
        .map((r) => r.permission),
    );
  } else {
    const defaults = DEFAULT_ROLE_PERMISSIONS[role];
    permissions = new Set(defaults.filter((p) => !isHeadOnlyPermission(p) || role === 'head'));
  }

  const rule = INSIGHT_ELEMENTS['home.my_work'].rule;
  if (rule === null) return false;
  if ('all' in rule) {
    return rule.all.every((p) => permissions.has(p));
  }
  return rule.anyOf.some((p) => permissions.has(p));
}
