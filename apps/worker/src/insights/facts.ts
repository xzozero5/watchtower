import {
  buildAlertsNoiseFacts,
  buildDashboardOpsNowFacts,
  buildDashboardQualityFacts,
  buildDashboardReliabilityFacts,
  buildDashboardServicesFacts,
  buildDashboardSlaFacts,
  buildDashboardTeamFacts,
  buildDashboardUsageFacts,
  buildDashboardVolumeFacts,
  buildIncidentDetailFacts,
  buildIncidentsOpenFacts,
  buildMyWorkFacts,
  buildOrgHealthFacts,
  buildReportsAiCostFacts,
  buildShiftOverviewFacts,
  type InsightExecutor,
  type InsightView,
} from '@watchtower/domain';
import type { InsightElementKey, InsightFactsResult } from '@watchtower/shared';

export interface BuildFactsRequest {
  readonly executor: InsightExecutor;
  readonly element: InsightElementKey;
  readonly period: string;
  readonly view: InsightView;
  readonly subjectUserId?: string;
  readonly scopeKey?: string;
}

function parseDays(period: string, fallback: number = 7): number {
  if (period.startsWith('d')) {
    const num = Number(period.slice(1));
    if (Number.isInteger(num) && num >= 1 && num <= 366) return num;
  }
  return fallback;
}

function parseRowId(scopeKey: string | undefined, expectedKind: string): string {
  if (!scopeKey) throw new Error(`Missing scopeKey for ${expectedKind}`);
  const [kind, id] = scopeKey.split(':');
  if (kind !== expectedKind || !id) {
    throw new Error(`Expected scopeKey kind ${expectedKind}, got "${scopeKey}"`);
  }
  return id;
}

/**
 * Builds deterministic facts for wave 9a and 9b mode N elements (T-415, T-420, ADR-029 section 9.2).
 */
export async function buildFactsForElement(
  request: BuildFactsRequest,
): Promise<InsightFactsResult> {
  const { executor, element, period, view, subjectUserId, scopeKey } = request;

  switch (element) {
    // --- Wave 9a ---
    case 'dashboard.ops.sla':
      return buildDashboardSlaFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'dashboard.ops.volume':
      return buildDashboardVolumeFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'alerts.noise':
      return buildAlertsNoiseFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'incidents.open':
      return buildIncidentsOpenFacts({
        executor,
        view,
      });

    case 'shift.overview':
    case 'home.team':
      return buildShiftOverviewFacts({
        executor,
        view,
      });

    case 'home.my_work':
      if (!subjectUserId) {
        throw new Error('home.my_work requires subjectUserId');
      }
      return buildMyWorkFacts({
        executor,
        subjectUserId,
        view,
      });

    // --- Wave 9b (T-420) ---
    case 'home.volume':
      return buildDashboardVolumeFacts({
        executor,
        days: parseDays(period, 90),
        view,
      });

    case 'dashboard.ops.now':
      return buildDashboardOpsNowFacts({
        executor,
        view,
      });

    case 'dashboard.ops.reliability':
      return buildDashboardReliabilityFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'dashboard.ops.services':
      return buildDashboardServicesFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'dashboard.ops.quality':
      return buildDashboardQualityFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'dashboard.ops.team':
      return buildDashboardTeamFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'dashboard.ops.usage':
      return buildDashboardUsageFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'reports.ai_cost':
      return buildReportsAiCostFacts({
        executor,
        days: parseDays(period, 7),
        view,
      });

    case 'incident.detail':
      return buildIncidentDetailFacts({
        executor,
        incidentId: parseRowId(scopeKey, 'incident'),
        view,
      });

    case 'org.health':
      return buildOrgHealthFacts({
        executor,
        orgId: parseRowId(scopeKey, 'org'),
        days: parseDays(period, 7),
        view,
      });

    default:
      throw new Error(`No facts builder available for element "${element}"`);
  }
}
