'use client';

import {
  DENSITIES,
  parseDensity,
  parseThemePreference,
  THEME_PREFERENCES,
  type Density,
  type ThemePreference,
} from '@watchtower/ui';
import { Button, cn, Select } from '@watchtower/ui';
import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { isLocale, LOCALE_NAMES, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { saveLocale } from '@/lib/locale-cookie';
import { setDensity, setSingleKeyShortcuts, setTheme, usePreferences } from '@/lib/preferences';

/**
 * Theme, density, language and the single-key shortcut switch, as native controls (keyboard and
 * screen reader support for free). The signed-in workspace has these in the account menu; this row
 * is for the sign-in page, where there is no account yet. From 1024 px they sit in a row; below
 * that they fold into a panel behind one button.
 */
export function PreferencesControls() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { theme, density, singleKeyShortcuts } = usePreferences();
  const themeId = useId();
  const densityId = useId();
  const languageId = useId();
  const singleKeyId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The folded panel closes on Escape (focus returns to its button) and on a click outside.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const themeLabel = (value: ThemePreference) => t(`prefs.theme.${value}`);
  const densityLabel = (value: Density) => t(`prefs.density.${value}`);

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={buttonRef}
        variant="secondary"
        aria-expanded={open}
        aria-controls={panelId}
        className="lg:hidden"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <SlidersHorizontal aria-hidden className="size-4" />
        <span className="sr-only">{t('topbar.preferences')}</span>
      </Button>
      <div
        id={panelId}
        role="group"
        aria-label={t('topbar.preferences')}
        className={cn(
          'z-30 flex-col gap-3 rounded-lg border border-border bg-surface p-3 shadow-overlay max-lg:absolute max-lg:top-full max-lg:right-0 max-lg:mt-1 max-lg:w-max',
          'lg:flex lg:flex-row lg:flex-wrap lg:items-center lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none',
          open ? 'flex' : 'hidden',
        )}
      >
        <div className="flex items-center gap-1.5">
          <label htmlFor={themeId} className="text-sm text-muted-foreground">
            {t('prefs.theme.label')}
          </label>
          <Select
            id={themeId}
            value={theme}
            onChange={(event) => {
              setTheme(parseThemePreference(event.target.value));
            }}
          >
            {THEME_PREFERENCES.map((value) => (
              <option key={value} value={value}>
                {themeLabel(value)}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <label htmlFor={densityId} className="text-sm text-muted-foreground">
            {t('prefs.density.label')}
          </label>
          <Select
            id={densityId}
            value={density}
            onChange={(event) => {
              setDensity(parseDensity(event.target.value));
            }}
          >
            {DENSITIES.map((value) => (
              <option key={value} value={value}>
                {densityLabel(value)}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <label htmlFor={languageId} className="text-sm text-muted-foreground">
            {t('prefs.language.label')}
          </label>
          <Select
            id={languageId}
            value={locale}
            onChange={(event) => {
              const next = event.target.value;
              if (!isLocale(next)) return;
              saveLocale(next);
              router.refresh();
            }}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value} lang={value}>
                {LOCALE_NAMES[value]}
              </option>
            ))}
          </Select>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            id={singleKeyId}
            type="checkbox"
            checked={singleKeyShortcuts}
            onChange={(event) => {
              setSingleKeyShortcuts(event.target.checked);
            }}
            className="size-4"
          />
          <label htmlFor={singleKeyId} className="text-sm text-muted-foreground">
            {t('prefs.singleKey.label')}
          </label>
        </div>
      </div>
    </div>
  );
}
