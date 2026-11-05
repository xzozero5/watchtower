import {
  buildAlertsNoiseFacts,
  buildDashboardSlaFacts,
  buildDashboardVolumeFacts,
  buildIncidentsOpenFacts,
  buildMyWorkFacts,
  buildShiftOverviewFacts,
  type InsightExecutor,
  type InsightView,
} from '@watchtower/domain';
import type { InsightElementKey, InsightFactsResult } from '@watchtower/shared';

import { daysOf } from './insight-scope.js';

/** What a builder is given: where to read, the view, and the settled scope and period. Never a principal. */
export interface BuildRequest {
  readonly executor: InsightExecutor;
  readonly view: InsightView;
  readonly period: string;
  /** The person `home.my_work` is about (their own, nobody else's). */
  readonly subjectUserId: string;
}

type Builder = (request: BuildRequest) => Promise<InsightFactsResult>;

/**
 * The facts builders of wave 9a (T-415). An element without one has no insight yet (mode R, X, or wave 9b) and is
 * left out of the answer the same way an element the person may not read is. An alias (`home.team`) is built by the
 * element it is an alias of.
 */
const BUILDERS: Partial<Record<InsightElementKey, Builder>> = {
  'dashboard.ops.sla': (request) =>
    buildDashboardSlaFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
    }),
  'dashboard.ops.volume': (request) =>
    buildDashboardVolumeFacts({
      executor: request.executor,
      view: request.view,
      days: daysOf(request.period),
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
};

export function builderFor(key: InsightElementKey): Builder | undefined {
  return BUILDERS[key];
}
