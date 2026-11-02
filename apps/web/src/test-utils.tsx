import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { AppShell } from '@/components/app-shell';
import { AuthGate } from '@/components/auth-gate';
import { Providers } from '@/components/providers';
import { getMessages, type Locale } from '@/i18n';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { socketFactory } from '@/test/fake-socket';

interface RenderOptions {
  locale?: Locale;
  apiUrl?: string;
  ticketKeyPrefix?: string;
}

/** Renders with the same providers as the real layout: language, runtime config, query, API, session. */
export function renderApp(
  ui: ReactElement,
  { locale = 'en', apiUrl = 'http://api.test', ticketKeyPrefix = 'OPS' }: RenderOptions = {},
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers
        locale={locale}
        messages={getMessages(locale)}
        config={{ apiUrl, ticketKeyPrefix }}
      >
        {children}
      </Providers>
    ),
  });
}

/**
 * The signed-in workspace as the home page builds it (auth gate, realtime, shell), with a fake
 * WebSocket the test can drive. Stub `fetch` with `mockApi` first.
 */
export function renderWorkspace(options: RenderOptions = {}) {
  const sockets = socketFactory();
  const result = renderApp(
    <AuthGate>
      <RealtimeProvider createSocket={sockets.create}>
        <AppShell />
      </RealtimeProvider>
    </AuthGate>,
    options,
  );
  return { ...result, sockets };
}
