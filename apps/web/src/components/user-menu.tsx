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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  parseDensity,
  parseThemePreference,
  THEME_PREFERENCES,
  TINT_CLASSES,
  Tooltip,
} from '@watchtower/ui';
import { Globe, Keyboard, LogOut, Rows3, SunMoon } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { isLocale, LOCALE_NAMES, LOCALES } from '@/i18n';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { saveLocale } from '@/lib/locale-cookie';
import { SIDE_BY_SIDE_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { setDensity, setSingleKeyShortcuts, setTheme, usePreferences } from '@/lib/preferences';

/**
 * The avatar at the foot of the rail. It opens the account menu: Theme, Density and Language as
 * radio submenus, the single-key shortcut switch, the keyboard map and Sign out. These used to be
 * a row of native selects in a top bar.
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
  const { theme, density, singleKeyShortcuts } = usePreferences();
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
          density={density}
          locale={locale}
          singleKeyShortcuts={singleKeyShortcuts}
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

function MenuBody({
  name,
  detail,
  theme,
  density,
  locale,
  singleKeyShortcuts,
  onShowShortcuts,
  onLocale,
  onSignOut,
}: {
  name: string;
  detail: string;
  theme: ReturnType<typeof usePreferences>['theme'];
  density: ReturnType<typeof usePreferences>['density'];
  locale: string;
  singleKeyShortcuts: boolean;
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

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SunMoon aria-hidden className={`size-4 ${TINT_CLASSES.amber.icon}`} />
          {t('prefs.theme.label')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => {
              setTheme(parseThemePreference(value));
            }}
          >
            {THEME_PREFERENCES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {t(`prefs.theme.${value}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Rows3 aria-hidden className={`size-4 ${TINT_CLASSES.sky.icon}`} />
          {t('prefs.density.label')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={density}
            onValueChange={(value) => {
              setDensity(parseDensity(value));
            }}
          >
            {DENSITIES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {t(`prefs.density.${value}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <Globe aria-hidden className={`size-4 ${TINT_CLASSES.green.icon}`} />
          {t('prefs.language.label')}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => {
              if (isLocale(value)) onLocale(value);
            }}
          >
            {LOCALES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} lang={value}>
                {LOCALE_NAMES[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={singleKeyShortcuts}
        onCheckedChange={(checked) => {
          setSingleKeyShortcuts(checked);
        }}
      >
        {t('prefs.singleKey.label')}
      </DropdownMenuCheckboxItem>
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
