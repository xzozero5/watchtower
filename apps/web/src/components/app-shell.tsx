'use client';

import { Button, Kbd } from '@watchtower/ui';
import { Command as CommandIcon } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { ApiStatus } from '@/components/api-status';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { buildCommands } from '@/components/command-palette/commands';
import { usePaletteShortcut } from '@/components/command-palette/use-palette-shortcut';
import { PreferencesControls } from '@/components/preferences-controls';
import { ThreePane } from '@/components/three-pane';
import { useT } from '@/i18n/provider';
import { saveLocale } from '@/lib/locale-cookie';
import { setDensity, setTheme } from '@/lib/preferences';

const subscribeNever = () => () => undefined;
const detectMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
const serverIsMac = () => false;
const clientHydrated = () => true;
const serverHydrated = () => false;

/** Top bar, the three panes, and the command palette that opens with Ctrl+K or Cmd+K. */
export function AppShell() {
  const t = useT();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const isMac = useSyncExternalStore(subscribeNever, detectMac, serverIsMac);
  // False in the server HTML, true once React has taken over. The e2e tests wait for it.
  const hydrated = useSyncExternalStore(subscribeNever, clientHydrated, serverHydrated);

  const togglePalette = useCallback(() => {
    setPaletteOpen((open) => !open);
  }, []);
  usePaletteShortcut(togglePalette);

  const commands = useMemo(
    () =>
      buildCommands(t, {
        setTheme,
        setDensity,
        setLocale: (locale) => {
          saveLocale(locale);
          router.refresh();
        },
      }),
    [t, router],
  );

  return (
    <div data-hydrated={hydrated} className="flex min-h-dvh flex-col lg:h-dvh">
      <a
        href="#pane-conversation"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t('app.skipToContent')}
      </a>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-surface px-pane py-2">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {/* The name sits next to it as text, so the icon adds nothing for a screen reader. */}
            <Image
              src="/brand/watchtower-icon.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-md"
              priority
            />
            <p className="text-base font-semibold">{t('app.name')}</p>
          </div>
          <ApiStatus />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <PreferencesControls />
          <Button variant="secondary" aria-keyshortcuts="Control+K Meta+K" onClick={togglePalette}>
            <CommandIcon aria-hidden className="size-4" />
            <span className="sr-only">{t('topbar.openPalette')}</span>
            <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
          </Button>
        </div>
      </header>
      <ThreePane />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
    </div>
  );
}
