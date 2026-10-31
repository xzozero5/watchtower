'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';

import { SESSION_QUERY_KEY } from '@/lib/auth/session-key';
import { markSignedIn, markSignedOut } from '@/lib/auth/session-hint';

import { ApiClient } from './client';
import { createEndpoints, type Endpoints } from './endpoints';

interface ApiValue {
  client: ApiClient;
  api: Endpoints;
}

const ApiContext = createContext<ApiValue | null>(null);

/**
 * One API client per browser tab. Its callbacks keep the TanStack Query cache honest about the
 * session: a refresh stores the new session, a failed refresh stores `null` ("signed out") and
 * the auth gate sends the user to the login page.
 */
export function ApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [value] = useState<ApiValue>(() => {
    const client = new ApiClient({
      baseUrl,
      onSession: (session) => {
        markSignedIn();
        queryClient.setQueryData(SESSION_QUERY_KEY, session);
      },
      onSessionExpired: () => {
        markSignedOut();
        queryClient.setQueryData(SESSION_QUERY_KEY, null);
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
