'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, TooltipProvider } from '@watchtower/ui';
import { type ReactNode, useState } from 'react';

import { RegisterServiceWorker } from '@/components/register-service-worker';
import { I18nProvider, useT } from '@/i18n/provider';
import type { Locale } from '@/i18n';
import type { Messages } from '@/i18n/messages/en';
import { ApiProvider } from '@/lib/api/api-context';
import { SessionProvider } from '@/lib/auth/session';
import type { RuntimeConfig } from '@/lib/runtime-config';
import { RuntimeConfigProvider } from '@/lib/runtime-config-context';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // A failed read shows its error with a "Try again" button at once. The api client already
        // handles the one failure worth retrying behind the scenes (an expired access token), and
        // TanStack Query refetches failed queries when the browser comes back online.
        retry: false,
      },
    },
  });
}

/** The toast region, named in the UI language. */
function ToastHost() {
  const t = useT();
  return <Toaster regionLabel={t('toast.region')} />;
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
        <QueryClientProvider client={queryClient}>
          <ApiProvider baseUrl={config.apiUrl}>
            <SessionProvider>
              <TooltipProvider>{children}</TooltipProvider>
              <ToastHost />
              <RegisterServiceWorker />
            </SessionProvider>
          </ApiProvider>
        </QueryClientProvider>
      </I18nProvider>
    </RuntimeConfigProvider>
  );
}
