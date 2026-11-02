'use client';

import { useMemo } from 'react';

import { useRuntimeConfig } from '@/lib/runtime-config-context';

import { StatusClient } from './status-client';

/** The api client of the public status pages. Nothing here uses the staff session. */
export function useStatusApi(): StatusClient {
  const { apiUrl } = useRuntimeConfig();
  return useMemo(() => new StatusClient({ baseUrl: apiUrl }), [apiUrl]);
}
