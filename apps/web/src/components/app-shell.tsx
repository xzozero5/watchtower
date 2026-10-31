'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import { CommandPalette } from '@/components/command-palette/command-palette';
import { buildCommands } from '@/components/command-palette/commands';
import { usePaletteShortcut } from '@/components/command-palette/use-palette-shortcut';
import { KeyboardMap } from '@/components/keyboard-map';
import { NavRail } from '@/components/nav-rail';
import { Workspace } from '@/components/workspace';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { saveLocale } from '@/lib/locale-cookie';
import { setDensity, setSingleKeyShortcuts, setTheme } from '@/lib/preferences';
import { useModifierShortcut } from '@/lib/use-modifier-shortcut';

const subscribeNever = () => () => undefined;
const detectMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
const serverIsMac = () => false;
const clientHydrated = () => true;
const serverHydrated = () => false;

/**
 * The navigation rail, the workspace (queue, conversation, details panel), the command palette
 * (Ctrl+K or Cmd+K) and the keyboard map (`?`). Render it inside the auth gate and the realtime
 * provider.
 */
export function AppShell() {
  const t = useT();
  const router = useRouter();
  const { signOut } = useSession();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const isMac = useSyncExternalStore(subscribeNever, detectMac, serverIsMac);
  // False in the server HTML, true once React has taken over. The e2e tests wait for it.
  const hydrated = useSyncExternalStore(subscribeNever, clientHydrated, serverHydrated);

  const togglePalette = useCallback(() => {
    setPaletteOpen((open) => !open);
  }, []);
  const toggleRail = useCallback(() => {
    setRailExpanded((expanded) => !expanded);
  }, []);
  usePaletteShortcut(togglePalette);
  useModifierShortcut('b', toggleRail);
  useShortcut('?', () => {
    setHelpOpen(true);
  });

  const commands = useMemo(
    () =>
      buildCommands(t, {
        setTheme,
        setDensity,
        setSingleKeyShortcuts,
        setLocale: (locale) => {
          saveLocale(locale);
          router.refresh();
        },
        showShortcuts: () => {
          setHelpOpen(true);
        },
        focusSearch: () => {
          // Wait for the palette to close and give focus back before moving it.
          setTimeout(() => document.getElementById('queue-search')?.focus(), 0);
        },
        signOut: () => {
          void signOut();
        },
      }),
    [t, router, signOut],
  );

  return (
    <div data-hydrated={hydrated} className="flex h-dvh flex-col md:flex-row">
      <a
        href="#pane-conversation"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t('app.skipToContent')}
      </a>
      <NavRail
        expanded={railExpanded}
        onToggleExpanded={toggleRail}
        onOpenPalette={togglePalette}
        onOpenKeymap={() => {
          setHelpOpen(true);
        }}
        isMac={isMac}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Workspace />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <KeyboardMap open={helpOpen} onOpenChange={setHelpOpen} isMac={isMac} />
    </div>
  );
}
