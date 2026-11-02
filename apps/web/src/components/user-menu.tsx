'use client';

import {
  Avatar,
  DENSITIES,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FlagIcon,
  parseDensity,
  parseThemePreference,
  TINT_CLASSES,
  Tooltip,
} from '@watchtower/ui';
import { Keyboard, LogOut, Moon, Rows2, Rows4, SunMoon } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { isLocale, LOCALE_FLAGS, LOCALE_LABELS, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { useDarkInEffect } from '@/components/display-controls';
import { useSession } from '@/lib/auth/session';
import { saveLocale } from '@/lib/locale-cookie';
import { SIDE_BY_SIDE_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { setDensity, setTheme, usePreferences } from '@/lib/preferences';

/**
 * The avatar at the foot of the rail. It opens the account menu: one row of language flags and
 * density icons, the dark theme switch (with "Follow system" once a theme is saved), the keyboard
 * map and Sign out. The single-key shortcut switch lives in the keyboard map.
 */
export function UserMenu({
  onShowShortcuts,
  showLabel,
}: {
  onShowShortcuts: () => void;
  /** In the expanded rail the name sits next to the avatar. */
  showLabel: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { session, signOut } = useSession();
  const { theme, density } = usePreferences();
  const dark = useDarkInEffect();
  const sideBySide = useMediaQuery(SIDE_BY_SIDE_QUERY);
  if (!session) return null;
  const { user } = session;

  return (
    <DropdownMenu>
      <Tooltip content={t('rail.account')} side="right" disabled={showLabel}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // Expanded, the trigger shows the name and role; the name then contains that text.
            aria-label={
              showLabel
                ? `${user.name} ${t(`roles.${user.role}`)}, ${t('rail.account')}`
                : t('rail.account')
            }
            className="flex h-control items-center gap-2.5 rounded-full px-1 text-left transition-colors duration-(--wt-motion-duration-fast) ease-out hover:bg-surface-muted data-[state=open]:bg-surface-muted md:px-1.5"
          >
            <Avatar name={user.name} id={user.id} size={24} />
            {showLabel ? (
              <span className="hidden min-w-0 flex-1 flex-col md:flex">
                <span className="truncate text-sm leading-tight font-medium">{user.name}</span>
                <span className="truncate text-xs leading-tight text-muted-foreground">
                  {t(`roles.${user.role}`)}
                </span>
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent
        // The rail is a column from 768px up (open to the right), a top bar below (open downwards).
        side={sideBySide ? 'right' : 'bottom'}
        align="end"
        className="w-64"
      >
        <MenuBody
          name={user.name}
          detail={`${user.email} · ${t(`roles.${user.role}`)}`}
          theme={theme}
          dark={dark}
          density={density}
          locale={locale}
          onShowShortcuts={onShowShortcuts}
          onLocale={(next) => {
            saveLocale(next);
            router.refresh();
          }}
          onSignOut={() => {
            void signOut();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A compact icon choice in the menu's row: the chosen one has a 2 px ring, not only a tint. */
const CHOICE =
  'size-9 min-h-0 flex-none justify-center rounded-full px-0 data-[state=checked]:bg-surface-muted data-[state=checked]:ring-2 data-[state=checked]:ring-primary';
const DENSITY_ICONS = { comfortable: Rows2, compact: Rows4 } as const;

function MenuBody({
  name,
  detail,
  theme,
  dark,
  density,
  locale,
  onShowShortcuts,
  onLocale,
  onSignOut,
}: {
  name: string;
  detail: string;
  theme: ReturnType<typeof usePreferences>['theme'];
  dark: boolean;
  density: ReturnType<typeof usePreferences>['density'];
  locale: string;
  onShowShortcuts: () => void;
  onLocale: (locale: (typeof LOCALES)[number]) => void;
  onSignOut: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs">{detail}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />

      {/* One row of choices: the language as two flags, the density as two icons. Each is a menu
          radio item (a plain button inside a menu is not valid ARIA), named by aria-label. */}
      <div className="flex items-center justify-center gap-3 px-1 py-1">
        <DropdownMenuRadioGroup
          aria-label={t('prefs.language.label')}
          value={locale}
          className="flex items-center gap-1.5"
          onValueChange={(value) => {
            if (isLocale(value)) onLocale(value);
          }}
        >
          {LOCALES.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              lang={value}
              hideIndicator
              aria-label={LOCALE_LABELS[value]}
              title={LOCALE_LABELS[value]}
              className={CHOICE}
            >
              <FlagIcon code={LOCALE_FLAGS[value]} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <span aria-hidden className="h-5 w-px bg-border" />
        <DropdownMenuRadioGroup
          aria-label={t('prefs.density.label')}
          value={density}
          className="flex items-center gap-1.5"
          onValueChange={(value) => {
            setDensity(parseDensity(value));
          }}
        >
          {DENSITIES.map((value) => {
            const Icon = DENSITY_ICONS[value];
            return (
              <DropdownMenuRadioItem
                key={value}
                value={value}
                hideIndicator
                aria-label={t(`prefs.density.${value}`)}
                title={t(`prefs.density.${value}`)}
                className={CHOICE}
              >
                <Icon aria-hidden className={`size-4 ${TINT_CLASSES.sky.icon}`} />
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </div>
      <DropdownMenuCheckboxItem
        checked={dark}
        onCheckedChange={(checked) => {
          setTheme(parseThemePreference(checked ? 'dark' : 'light'));
        }}
      >
        <Moon aria-hidden className={`size-4 ${TINT_CLASSES.amber.icon}`} />
        {t('prefs.theme.darkTheme')}
      </DropdownMenuCheckboxItem>
      {theme !== 'system' ? (
        <DropdownMenuItem
          onSelect={() => {
            setTheme('system');
          }}
        >
          <SunMoon aria-hidden className={`size-4 ${TINT_CLASSES.slate.icon}`} />
          {t('prefs.theme.followSystem')}
        </DropdownMenuItem>
      ) : null}

      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onShowShortcuts}>
        <Keyboard aria-hidden className={`size-4 ${TINT_CLASSES.violet.icon}`} />
        {t('topbar.openKeymap')}
        <DropdownMenuHint>?</DropdownMenuHint>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onSignOut}>
        <LogOut aria-hidden className={`size-4 ${TINT_CLASSES.slate.icon}`} />
        {t('topbar.signOut')}
      </DropdownMenuItem>
    </>
  );
}
