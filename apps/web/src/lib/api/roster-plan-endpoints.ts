import {
  applyRosterPlanResultSchema,
  rosterPlanDefaultsSchema,
  rosterPlanListSchema,
  rosterPlanSchema,
  type ApplyRosterPlan,
  type CreateRosterPlan,
  type EditRosterPlan,
  type ExplainRosterPlan,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The roster planner endpoints (T-305e, lead and head). One function per endpoint. */
export function createRosterPlanEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);

  return {
    rosterPlans: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/roster/plans',
        schema: rosterPlanListSchema,
        ...withSignal(signal),
      }),

    rosterPlanDefaults: (weekStart: string, signal?: AbortSignal) =>
      client.request({
        path: '/v1/roster/plans/defaults',
        query: { weekStart },
        schema: rosterPlanDefaultsSchema,
        ...withSignal(signal),
      }),

    rosterPlan: (planId: string, signal?: AbortSignal) =>
      client.request({
        path: `/v1/roster/plans/${id(planId)}`,
        schema: rosterPlanSchema,
        ...withSignal(signal),
      }),

    createRosterPlan: (body: CreateRosterPlan) =>
      client.request({
        method: 'POST',
        path: '/v1/roster/plans',
        body,
        schema: rosterPlanSchema,
      }),

    editRosterPlan: (planId: string, body: EditRosterPlan) =>
      client.request({
        method: 'PATCH',
        path: `/v1/roster/plans/${id(planId)}/entries`,
        body,
        schema: rosterPlanSchema,
      }),

    /** 503 `ai_unavailable` while the AI is off or offline: the plan itself is unaffected. */
    explainRosterPlan: (planId: string, body: ExplainRosterPlan) =>
      client.request({
        method: 'POST',
        path: `/v1/roster/plans/${id(planId)}/explain`,
        body,
        schema: rosterPlanSchema,
      }),

    applyRosterPlan: (planId: string, body: ApplyRosterPlan) =>
      client.request({
        method: 'POST',
        path: `/v1/roster/plans/${id(planId)}/apply`,
        body,
        schema: applyRosterPlanResultSchema,
      }),

    discardRosterPlan: (planId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/roster/plans/${id(planId)}/discard`,
        schema: rosterPlanSchema,
      }),
  };
}
