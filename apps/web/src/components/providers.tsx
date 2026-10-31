'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

import { I18nProvider } from '@/i18n/provider';
import type { Locale } from '@/i18n';
import type { Messages } from '@/i18n/messages/en';
import type { RuntimeConfig } from '@/lib/runtime-config';
import { RuntimeConfigProvider } from '@/lib/runtime-config-context';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function Providers({
  locale,
  messages,
  config,
  children,
}: {
  locale: Locale;
  messages: Messages;
  config: RuntimeConfig;
  children: ReactNode;
}) {
  // One client per browser session. useState keeps it stable across re-renders.
  const [queryClient] = useState(makeQueryClient);
  return (
    <RuntimeConfigProvider config={config}>
      <I18nProvider locale={locale} messages={messages}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </I18nProvider>
    </RuntimeConfigProvider>
  );
}
