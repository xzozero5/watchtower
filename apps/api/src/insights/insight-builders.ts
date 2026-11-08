import {
  buildAdminAiFacts,
  buildAdminIntentGateFacts,
  buildAdminIntentsFacts,
  buildAdminIntegrationsFacts,
  buildAdminOutboxFacts,
  buildAdminQueuesFacts,
  buildAlertsNoiseFacts,
  buildAlertsServicesFacts,
  buildDashboardAiFacts,
  buildDashboardGradesFacts,
  buildDashboardOpsNowFacts,
  buildDashboardQualityFacts,
  buildDashboardReliabilityFacts,
  buildDashboardServicesFacts,
  buildDashboardSlaFacts,
  buildDashboardTeamFacts,
  buildDashboardUsageFacts,
  buildDashboardVolumeFacts,
  buildHomeStatusFacts,
  buildIncidentDetailFacts,
  buildIncidentsOpenFacts,
  buildMyWorkFacts,
  buildOrgHealthFacts,
  buildQueueListFacts,
  buildReportsAiCostFacts,
  buildReportsCeoFiguresFacts,
  buildShiftOverviewFacts,
  buildStatuspageAdminFacts,
  type InsightExecutor,
  type InsightView,
} from '@watchtower/domain';
import type { InsightElementKey, InsightFactsResult, OrgScope } from '@watchtower/shared';

import { daysOf, parseRowId } from './insight-scope.js';

/** What a builder is given: where to read, the view, and the settled scope and period. Never a principal. */
export interface BuildRequest {
  readonly executor: InsightExecutor;
  readonly view: InsightView;
  readonly period: string;
  /** The person `home.my_work` or `queue.list` is about. */
  readonly subjectUserId: string;
  readonly scopeKey: string;
  readonly orgScope?: OrgScope;
}

type Builder = (request: BuildRequest) => Promise<InsightFactsResult>;

/**
 * The facts builders of wave 9a and 9b (T-415, T-420). An element without one has no insight yet (mode R, X) and is
 * left out of the answer the same way an element the person may not read is. An alias (`home.team`) is built by the
 * element it is an alias of.
 */
const BUILDERS: Partial<Record<InsightElementKey, Builder>> = {
  // --- Wave 9a (T-415) ---
  'dashboard.ops.sla': (request) =>
    buildDashboardSlaFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.volume': (request) =>
    buildDashboardVolumeFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'alerts.noise': (request) =>
    buildAlertsNoiseFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
    }),
  'incidents.open': (request) =>
    buildIncidentsOpenFacts({ executor: request.executor, view: request.view }),
  'shift.overview': (request) =>
    buildShiftOverviewFacts({ executor: request.executor, view: request.view }),
  'home.my_work': (request) =>
    buildMyWorkFacts({
      executor: request.executor,
      view: request.view,
      subjectUserId: request.subjectUserId,
    }),

  // --- Wave 9b (T-420) ---
  'home.volume': (request) =>
    buildDashboardVolumeFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'home.status': (request) =>
    buildHomeStatusFacts({ executor: request.executor, view: request.view }),
  'queue.list': (request) =>
    buildQueueListFacts({
      executor: request.executor,
      view: request.view,
      subjectUserId: request.subjectUserId,
      scope: request.orgScope,
    }),
  'dashboard.ops.now': (request) =>
    buildDashboardOpsNowFacts({
      executor: request.executor,
      view: request.view,
      scope: request.orgScope,
    }),
  'dashboard.ops.reliability': (request) =>
    buildDashboardReliabilityFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.services': (request) =>
    buildDashboardServicesFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.quality': (request) =>
    buildDashboardQualityFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.ai': (request) =>
    buildDashboardAiFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.grades': (request) =>
    buildDashboardGradesFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.team': (request) =>
    buildDashboardTeamFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'dashboard.ops.usage': (request) =>
    buildDashboardUsageFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
      scope: request.orgScope,
    }),
  'reports.ai_cost': (request) =>
    buildReportsAiCostFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
    }),
  'reports.ceo.figures': (request) =>
    buildReportsCeoFiguresFacts({
      executor: request.executor,
      view: request.view,
      isoWeek: request.period,
    }),
  'incident.detail': (request) =>
    buildIncidentDetailFacts({
      executor: request.executor,
      view: request.view,
      incidentId: parseRowId(request.scopeKey, 'incident'),
    }),
  'alerts.services': (request) =>
    buildAlertsServicesFacts({ executor: request.executor, view: request.view }),
  'statuspage.admin': (request) =>
    buildStatuspageAdminFacts({ executor: request.executor, view: request.view }),
  'org.health': (request) =>
    buildOrgHealthFacts({
      executor: request.executor,
      view: request.view,
      orgId: parseRowId(request.scopeKey, 'org'),
      days: daysOf(request.period),
    }),
  'admin.intents': (request) =>
    buildAdminIntentsFacts({
      executor: request.executor,
      view: request.view,
      intentId: parseRowId(request.scopeKey, 'intent'),
    }),
  'admin.intent.gate': (request) =>
    buildAdminIntentGateFacts({
      executor: request.executor,
      view: request.view,
      intentId: parseRowId(request.scopeKey, 'intent'),
    }),
  'admin.ai': (request) => buildAdminAiFacts({ executor: request.executor, view: request.view }),
  'admin.integrations': (request) =>
    buildAdminIntegrationsFacts({ executor: request.executor, view: request.view }),
  'admin.outbox': (request) =>
    buildAdminOutboxFacts({ executor: request.executor, view: request.view }),
  'admin.queues': (request) =>
    buildAdminQueuesFacts({ executor: request.executor, view: request.view }),
};

export function builderFor(key: InsightElementKey): Builder | undefined {
  return BUILDERS[key];
}
