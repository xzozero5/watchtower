'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Permission, type SessionInfo } from '@watchtower/shared';
import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';

import { useApi } from '@/lib/api/api-context';
import { isUnauthenticated } from '@/lib/api/errors';

import { draftStore } from '@/lib/tickets/templates';

import { hasSessionHint, markSignedOut } from './session-hint';
import { SESSION_QUERY_KEY } from './session-key';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface SessionState {
  status: SessionStatus;
  session: SessionInfo | null;
  /** True when the user holds this permission string. The api enforces it too; this hides actions. */
  can: (permission: Permission) => boolean;
  /** A customer user: sees their own organization only and never staff-only fields. */
  isClient: boolean;
  retry: () => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

/**
 * Loads `GET /v1/auth/session` once (the client sends the cookies; a 401 triggers the coordinated
 * refresh inside the API client). `anonymous` means there is no usable session: the auth gate then
 * shows the login page.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery<SessionInfo | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await api.session(signal, { refresh: hasSessionHint() });
      } catch (error) {
        if (isUnauthenticated(error)) return null;
        throw error;
      }
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnReconnect: false,
  });

  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The cookies may already be gone; either way this tab is done with the session.
    }
    markSignedOut();
    draftStore.clear();
    // Drop everything cached for this person, but keep the session query itself: it is what tells
    // the auth gate to leave.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] });
    queryClient.setQueryData(SESSION_QUERY_KEY, null);
  }, [api, queryClient]);

  const session = query.data ?? null;
  const value = useMemo<SessionState>(() => {
    const permissions = new Set(session?.permissions ?? []);
    const status: SessionStatus = query.isError
      ? 'error'
      : query.data === undefined
        ? 'loading'
        : session
          ? 'authenticated'
          : 'anonymous';
    return {
      status,
      session,
      can: (permission) => permissions.has(permission),
      isClient: session?.user.role === 'client',
      retry,
      signOut,
    };
  }, [query.isError, query.data, session, retry, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}
