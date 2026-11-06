'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantMemoryList, CreateAssistantMemory } from '@watchtower/shared';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { userScope } from '@/lib/tickets/queries';

export const assistantKeys = (userId: string) => {
  const all = [...userScope(userId), 'assistant'] as const;
  return {
    all,
    conversations: [...all, 'conversations'] as const,
    memory: [...all, 'memory'] as const,
  };
};

export function useAssistantConversations(enabled: boolean) {
  const api = useApi();
  const keys = assistantKeys(useUserId());
  return useQuery({
    queryKey: keys.conversations,
    queryFn: ({ signal }) => api.assistantConversations(signal),
    enabled,
    retry: false,
  });
}

export function useAssistantMemory(enabled: boolean) {
  const api = useApi();
  const keys = assistantKeys(useUserId());
  return useQuery({
    queryKey: keys.memory,
    queryFn: ({ signal }) => api.assistantMemory(signal),
    enabled,
    retry: false,
  });
}

export function usePinAssistantMemory() {
  const api = useApi();
  const client = useQueryClient();
  const keys = assistantKeys(useUserId());
  return useMutation({
    mutationFn: (input: CreateAssistantMemory) => api.pinAssistantMemory(input),
    retry: false,
    onSuccess: (item) => {
      client.setQueryData<AssistantMemoryList>(keys.memory, (current) =>
        current
          ? { items: [item, ...current.items.filter((row) => row.id !== item.id)] }
          : undefined,
      );
      void client.invalidateQueries({ queryKey: keys.memory });
    },
  });
}

export type LibraryAction = { kind: 'conversation' | 'memory'; id: string } | { kind: 'clear' };

export function useAssistantLibraryAction() {
  const api = useApi();
  const client = useQueryClient();
  const keys = assistantKeys(useUserId());
  return useMutation({
    retry: false,
    mutationFn: async (action: LibraryAction) => {
      if (action.kind === 'conversation') await api.deleteAssistantConversation(action.id);
      else if (action.kind === 'memory') await api.deleteAssistantMemory(action.id);
      else await api.clearAssistantMemory();
    },
    onSuccess: (_data, action) => {
      if (action.kind !== 'conversation')
        client.setQueryData<AssistantMemoryList>(keys.memory, (current) =>
          current
            ? {
                items:
                  action.kind === 'clear'
                    ? []
                    : current.items.filter((row) => row.id !== action.id),
              }
            : undefined,
        );
      return client.invalidateQueries({
        queryKey: action.kind === 'conversation' ? keys.conversations : keys.memory,
      });
    },
  });
}
