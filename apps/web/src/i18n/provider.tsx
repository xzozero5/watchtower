'use client';

import { createContext, type ReactNode, useContext, useMemo } from 'react';

import { type Locale, type Translate, translate } from './index';
import type { Messages } from './messages/en';

interface I18nValue {
  locale: Locale;
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  const value = useMemo<I18nValue>(
    () => ({ locale, t: (key, values) => translate(messages, key, values) }),
    [locale, messages],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside <I18nProvider>');
  return value;
}

/** The translate function for the current language. */
export function useT(): Translate {
  return useI18n().t;
}
