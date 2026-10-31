'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@watchtower/shared';
import { createContext, type ReactNode, useContext, useState } from 'react';

import { endSession } from '@/lib/auth/end-session';
import { markSignedIn } from '@/lib/auth/session-hint';
import { SESSION_QUERY_KEY } from '@/lib/auth/session-key';

import { ApiClient } from './client';
import { createEndpoints, type Endpoints } from './endpoints';

interface ApiValue {
  client: ApiClient;
  api: Endpoints;
}

const ApiContext = createContext<ApiValue | null>(null);

/**
 * One API client per browser tab. Its callbacks keep the TanStack Query cache honest about the
 * session: a refresh stores the new session, a failed refresh ends the session exactly like
 * signing out (cache and unsent drafts cleared, session `null`) and the auth gate sends the user
 * to the login page.
 */
export function ApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [value] = useState<ApiValue>(() => {
    const client = new ApiClient({
      baseUrl,
      onSession: (session) => {
        markSignedIn();
        // A different person now holds the session in this tab (for example signed in from another
        // tab): drop what the previous person had before storing the new session.
        const previous = queryClient.getQueryData<SessionInfo | null>(SESSION_QUERY_KEY);
        if (previous && previous.user.id !== session.user.id) endSession(queryClient);
        queryClient.setQueryData(SESSION_QUERY_KEY, session);
      },
      onSessionExpired: () => {
        endSession(queryClient);
      },
    });
    return { client, api: createEndpoints(client) };
  });
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): Endpoints {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi must be used inside <ApiProvider>');
  return value.api;
}
