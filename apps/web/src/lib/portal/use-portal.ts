'use client';

import { useEffect, useMemo, useState } from 'react';

import { useRuntimeConfig } from '@/lib/runtime-config-context';

import { HumanCheck, type CheckState } from './human-check';
import { PortalClient } from './portal-client';

/** The api client of the public portal. Nothing here uses the staff session. */
export function usePortalApi(): PortalClient {
  const { apiUrl } = useRuntimeConfig();
  return useMemo(() => new PortalClient({ baseUrl: apiUrl }), [apiUrl]);
}

/**
 * Starts the human check when the form opens and ends it when the form goes away. `check` stays the
 * same object for the life of the page; `state` drives the "Checking you're human…" line.
 */
export function useHumanCheck(api: Pick<PortalClient, 'challenge'>): {
  check: HumanCheck;
  state: CheckState;
} {
  const [state, setState] = useState<CheckState>({ phase: 'loading' });
  const [check] = useState(() => new HumanCheck({ api, onChange: setState }));

  useEffect(() => {
    // React runs effects twice in development: start() brings a disposed check back to life.
    check.start();
    return () => {
      check.dispose();
    };
  }, [check]);

  return { check, state };
}
