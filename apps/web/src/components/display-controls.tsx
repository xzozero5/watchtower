'use client';

import { LanguageFlags, parseThemePreference, ThemeSwitch } from '@watchtower/ui';
import { useRouter } from 'next/navigation';

import { isLocale, LOCALE_FLAGS, LOCALE_LABELS, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { saveLocale } from '@/lib/locale-cookie';
import { setTheme, usePreferences } from '@/lib/preferences';
import { useMediaQuery } from '@/lib/use-media-query';

/** Whether the dark theme is the one in effect: the saved choice, else what the system asks for. */
export function useDarkInEffect(): boolean {
  const { theme } = usePreferences();
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)', false);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

/** The moon / sun switch. The first press saves the opposite of what is in effect. */
export function DarkThemeSwitch({ className }: { className?: string }) {
  const { t } = useI18n();
  const dark = useDarkInEffect();
  return (
    <ThemeSwitch
      dark={dark}
      label={t('prefs.theme.darkTheme')}
      {...(className ? { className } : {})}
      onDarkChange={(next) => {
        setTheme(parseThemePreference(next ? 'dark' : 'light'));
      }}
    />
  );
}

/** One flag per language; the choice is saved in the cookie and the server render is refreshed. */
export function LanguageSwitch({ className }: { className?: string }) {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <LanguageFlags
      aria-label={t('prefs.language.label')}
      value={locale}
      {...(className ? { className } : {})}
      options={LOCALES.map((value) => ({
        value,
        flag: LOCALE_FLAGS[value],
        label: LOCALE_LABELS[value],
      }))}
      onValueChange={(next) => {
        if (!isLocale(next)) return;
        saveLocale(next);
        router.refresh();
      }}
    />
  );
}

/**
 * Theme and language, the two things a person may want to change before they can read the page:
 * a switch and two flags. For the sign-in page and the public portal, where there is no account
 * menu. Density and the single-key shortcut switch are not needed before sign-in.
 */
export function DisplayControls() {
  return (
    <div className="flex items-center gap-3">
      <LanguageSwitch />
      <DarkThemeSwitch />
    </div>
  );
}
