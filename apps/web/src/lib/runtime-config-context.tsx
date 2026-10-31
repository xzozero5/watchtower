'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { RuntimeConfig } from './runtime-config';

const RuntimeConfigContext = createContext<RuntimeConfig | null>(null);

/** Hands the server-read runtime config to client components. See runtime-config.ts. */
export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  const config = useContext(RuntimeConfigContext);
  if (!config) throw new Error('useRuntimeConfig must be used inside <RuntimeConfigProvider>');
  return config;
}
