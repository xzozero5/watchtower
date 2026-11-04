'use client';

import { useQuery } from '@tanstack/react-query';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

export const rosterPlanKeys = (userId: string) => {
  const all = [...userScope(userId), 'roster-plans'] as const;
  return {
    all,
    list: [...all, 'list'] as const,
    defaults: (weekStart: string) => [...all, 'defaults', weekStart] as const,
    plan: (id: string) => [...all, 'plan', id] as const,
  };
};

/** Recent plans of the roster planner (T-305e), newest first. */
export function useRosterPlans() {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: rosterPlanKeys(userId).list,
    queryFn: ({ signal }) => api.rosterPlans(signal),
    staleTime: 10_000,
  });
}

/** What a new plan starts from: people, shifts, rules and a coverage guess from ticket volume. */
export function useRosterPlanDefaults(weekStart: string, enabled = true) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: rosterPlanKeys(userId).defaults(weekStart),
    queryFn: ({ signal }) => api.rosterPlanDefaults(weekStart, signal),
    enabled,
    staleTime: 60_000,
  });
}

export function useRosterPlan(id: string) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: rosterPlanKeys(userId).plan(id),
    queryFn: ({ signal }) => api.rosterPlan(id, signal),
    staleTime: 5_000,
  });
}
