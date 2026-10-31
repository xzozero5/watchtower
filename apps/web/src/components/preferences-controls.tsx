'use client';

import {
  DENSITIES,
  parseDensity,
  parseThemePreference,
  THEME_PREFERENCES,
  type Density,
  type ThemePreference,
} from '@watchtower/ui';
import { useRouter } from 'next/navigation';
import { useId } from 'react';

import { isLocale, LOCALE_NAMES, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { saveLocale } from '@/lib/locale-cookie';
import { setDensity, setTheme, usePreferences } from '@/lib/preferences';

const SELECT_CLASS =
  'h-control rounded-md border border-border-strong bg-surface px-2 text-sm text-foreground';

/** Theme, density and language. Native selects: keyboard and screen reader support for free. */
export function PreferencesControls() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { theme, density } = usePreferences();
  const themeId = useId();
  const densityId = useId();
  const languageId = useId();

  const themeLabel = (value: ThemePreference) => t(`prefs.theme.${value}`);
  const densityLabel = (value: Density) => t(`prefs.density.${value}`);

  return (
    <div
      role="group"
      aria-label={t('topbar.preferences')}
      className="flex flex-wrap items-center gap-3"
    >
      <div className="flex items-center gap-1.5">
        <label htmlFor={themeId} className="text-sm text-muted-foreground">
          {t('prefs.theme.label')}
        </label>
        <select
          id={themeId}
          value={theme}
          onChange={(event) => {
            setTheme(parseThemePreference(event.target.value));
          }}
          className={SELECT_CLASS}
        >
          {THEME_PREFERENCES.map((value) => (
            <option key={value} value={value}>
              {themeLabel(value)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <label htmlFor={densityId} className="text-sm text-muted-foreground">
          {t('prefs.density.label')}
        </label>
        <select
          id={densityId}
          value={density}
          onChange={(event) => {
            setDensity(parseDensity(event.target.value));
          }}
          className={SELECT_CLASS}
        >
          {DENSITIES.map((value) => (
            <option key={value} value={value}>
              {densityLabel(value)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <label htmlFor={languageId} className="text-sm text-muted-foreground">
          {t('prefs.language.label')}
        </label>
        <select
          id={languageId}
          value={locale}
          onChange={(event) => {
            const next = event.target.value;
            if (!isLocale(next)) return;
            saveLocale(next);
            router.refresh();
          }}
          className={SELECT_CLASS}
        >
          {LOCALES.map((value) => (
            <option key={value} value={value} lang={value}>
              {LOCALE_NAMES[value]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
