'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateProcedureVersion, UpdateProcedureVersion } from '@watchtower/shared';

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
