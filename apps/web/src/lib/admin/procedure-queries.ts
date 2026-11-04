'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProcedureVersion, UpdateProcedureVersion } from '@watchtower/shared';
import { useEffect, useState } from 'react';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

export const procedureKeys = (userId: string, intentId: string) => {
  const all = [...userScope(userId), 'procedure', intentId] as const;
  return {
    all,
    versions: [...all, 'versions'] as const,
    validation: (versionId: string) => [...all, 'validation', versionId] as const,
  };
};

/** The versions of an intent's procedure, newest first, and which one is live. */
export function useProcedureVersions(intentId: string, enabled: boolean) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: procedureKeys(userId, intentId).versions,
    queryFn: ({ signal }) => api.procedureVersions(intentId, signal),
    enabled,
  });
}

/** What is wrong with the saved steps of one version (the api checks them against this instance). */
export function useProcedureValidation(intentId: string, versionId: string | null) {
  const api = useApi();
  const userId = useUserId();
  return useQuery({
    queryKey: procedureKeys(userId, intentId).validation(versionId ?? 'none'),
    queryFn: ({ signal }) => api.procedureValidation(intentId, versionId ?? '', signal),
    enabled: versionId !== null,
  });
}

/** A run is on while no simulation other than the one seen at the start has appeared (`seen` undefined: none read yet). */
function stillRunning(previousId: string | null, seen: string | undefined): boolean {
  return seen === undefined || seen === previousId;
}

/** How often the result of a queued simulation is asked for, and how long the page waits before it says "slow". */
export const SIMULATION_POLL_MS = 2000;
export const SIMULATION_WAIT_MS = 10 * 60_000;

/**
 * The simulation of one version (T-303f, T-303d): `start` queues a run (202), then the result is asked for every
 * `SIMULATION_POLL_MS` until a simulation other than the one seen at the start appears (the worker writes a row
 * for a pass and for a fail). `start` is refused with 409 (not in a status that can be simulated) or 503 (the AI
 * cannot run): the caller shows the reason. The result is read once something exists (`hasResult`) or a run is going.
 */
export function useProcedureSimulation(
  intentId: string,
  version: { id: string; simulation: { id: string } | null },
) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const keys = procedureKeys(userId, intentId);
  const [run, setRun] = useState<{ previousId: string | null } | null>(null);
  const [slow, setSlow] = useState(false);

  const query = useQuery({
    queryKey: [...keys.all, 'simulation', version.id] as const,
    queryFn: ({ signal }) => api.procedureSimulation(intentId, version.id, signal),
    enabled: version.simulation !== null || run !== null,
    retry: false,
    refetchInterval: (current) =>
      run !== null && stillRunning(run.previousId, current.state.data?.simulation?.id)
        ? SIMULATION_POLL_MS
        : false,
  });
  const latestId = query.data?.simulation?.id ?? null;
  // Over when a simulation other than the one seen at the start has appeared (derived: nothing is set in an effect).
  const running = run !== null && stillRunning(run.previousId, query.data?.simulation?.id);
  const finished = run !== null && !running;

  // Once, when the run ends: the version moved to `simulated` and its summary changed.
  useEffect(() => {
    if (finished) {
      void queryClient.invalidateQueries({ queryKey: procedureKeys(userId, intentId).all });
    }
  }, [finished, queryClient, userId, intentId]);

  useEffect(() => {
    if (run === null) return;
    const timer = setTimeout(() => {
      setRun(null);
      setSlow(true);
    }, SIMULATION_WAIT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [run]);

  const start = useMutation({
    mutationFn: () => api.simulateProcedureVersion(intentId, version.id),
    onMutate: () => {
      setSlow(false);
    },
    onSuccess: () => {
      setRun({ previousId: latestId ?? version.simulation?.id ?? null });
    },
  });

  return {
    result: query.data?.simulation ?? null,
    resultError: query.isError,
    running,
    slow,
    start,
  };
}

/** Every write of the editor. Each one refreshes the version list and the validation of the version it touched. */
export function useProcedureMutations(intentId: string) {
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const keys = procedureKeys(userId, intentId);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.all });

  return {
    create: useMutation({
      mutationFn: (body: CreateProcedureVersion) => api.createProcedureVersion(intentId, body),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: (input: { versionId: string; body: UpdateProcedureVersion }) =>
        api.updateProcedureVersion(intentId, input.versionId, input.body),
      onSuccess: refresh,
    }),
    compile: useMutation({
      mutationFn: (versionId: string) => api.compileProcedureVersion(intentId, versionId),
      onSuccess: refresh,
    }),
    confirm: useMutation({
      mutationFn: (versionId: string) => api.confirmProcedureVersion(intentId, versionId),
      onSuccess: refresh,
    }),
    publish: useMutation({
      mutationFn: (versionId: string) => api.publishProcedureVersion(intentId, versionId),
      onSuccess: refresh,
    }),
    retire: useMutation({
      mutationFn: (versionId: string) => api.retireProcedureVersion(intentId, versionId),
      onSuccess: refresh,
    }),
  };
}
