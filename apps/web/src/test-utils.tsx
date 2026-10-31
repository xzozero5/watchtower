import { render } from '@testing-library/react';
import type { ReactElement } from 'react';

import { Providers } from '@/components/providers';
import { getMessages, type Locale } from '@/i18n';

/** Renders with the same providers as the real layout: language, runtime config, TanStack Query. */
export function renderApp(
  ui: ReactElement,
  { locale = 'en', apiUrl = 'http://api.test' }: { locale?: Locale; apiUrl?: string } = {},
) {
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers locale={locale} messages={getMessages(locale)} config={{ apiUrl }}>
        {children}
      </Providers>
    ),
  });
}
