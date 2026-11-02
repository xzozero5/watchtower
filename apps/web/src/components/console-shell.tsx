'use client';

import { AppFrame, cn } from '@watchtower/ui';
import { useRouter } from 'next/navigation';
import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  SwitchConfirmDialog,
  type SwitchTarget,
} from '@/components/admin/ai/switch-confirm-dialog';
import { AiPausedBanner } from '@/components/admin/ai/ai-paused-banner';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { buildCommands } from '@/components/command-palette/commands';
import { usePaletteShortcut } from '@/components/command-palette/use-palette-shortcut';
import { KeyboardMap } from '@/components/keyboard-map';
import { NavRail, type RailDestination } from '@/components/nav-rail';
import { CriticalBanner } from '@/components/notifications/critical-banner';
import { useT } from '@/i18n/provider';
import { useAutonomy } from '@/lib/admin/queries';
import { adminSectionsFor, HOME_PERMISSION } from '@/lib/admin/sections';
import { useSession } from '@/lib/auth/session';
import { useShortcut, useShortcutSequence } from '@/lib/keyboard';
import { saveLocale } from '@/lib/locale-cookie';
import { setDensity, setSingleKeyShortcuts, setTheme } from '@/lib/preferences';
import { shiftSectionsFor } from '@/lib/shifts/sections';
import { useModifierShortcut } from '@/lib/use-modifier-shortcut';

const subscribeNever = () => () => undefined;
const detectMac = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
const serverIsMac = () => false;
const clientHydrated = () => true;
const serverHydrated = () => false;

export interface ConsoleShellProps {
  /** Which rail item is current. */
  destination: RailDestination;
  /** What the skip link jumps to, and its words. */
  skipTo: { href: string; label: 'app.skipToContent' | 'app.skipToMain' };
  children: ReactNode;
}

/**
 * Everything around a page of the signed-in app: the navigation rail, the command palette
 * (Ctrl or Cmd + K), the keyboard map (`?`), the AI-paused banner and the AI switch dialog that the
 * palette can open. The queue workspace, Home and Admin all render inside it. Render it inside the
 * auth gate and the realtime provider.
 */
export function ConsoleShell({ destination, skipTo, children }: ConsoleShellProps) {
  const t = useT();
  const router = useRouter();
  const { signOut, can } = useSession();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<SwitchTarget | null>(null);
  const isMac = useSyncExternalStore(subscribeNever, detectMac, serverIsMac);
  // False in the server HTML, true once React has taken over. The e2e tests wait for it.
  const hydrated = useSyncExternalStore(subscribeNever, clientHydrated, serverHydrated);
  const autonomy = useAutonomy(can('ticket.read'));
  const killOn = autonomy.data?.switches.find((item) => item.key === 'ai_kill_switch')?.on ?? false;
  const capOn =
    autonomy.data?.switches.find((item) => item.key === 'ai_stage_cap_pinned')?.on ?? false;

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

  const goHome = useCallback(() => {
    router.push('/home');
  }, [router]);
  const goAdmin = useCallback(
    (href?: string) => {
      router.push(href ?? adminSectionsFor(can)[0]?.href ?? '/admin');
    },
    [router, can],
  );
  const goTo = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );
  const shiftIds = new Set(shiftSectionsFor(can).map((section) => section.id));
  const showHome = can(HOME_PERMISSION);
  const showAdmin = adminSectionsFor(can).length > 0;
  const showOtherMail = can('inbound.read');
  // `g d`, `g a`, `g o` and, away from the queue, `g q`. The queue workspace handles its own `g q`.
  useShortcutSequence('g', {
    ...(showHome ? { d: goHome } : {}),
    ...(showOtherMail
      ? {
          o: () => {
            router.push('/other-mail');
          },
        }
      : {}),
    ...(showAdmin
      ? {
          a: () => {
            goAdmin();
          },
        }
      : {}),
    ...(shiftIds.has('shift')
      ? {
          s: () => {
            goTo('/shift');
          },
        }
      : {}),
    ...(shiftIds.has('brief')
      ? {
          b: () => {
            goTo('/shift/brief');
          },
        }
      : {}),
    ...(shiftIds.has('handoff')
      ? {
          h: () => {
            goTo('/shift/handoff');
          },
        }
      : {}),
    ...(destination !== 'queue'
      ? {
          q: () => {
            router.push('/');
          },
        }
      : {}),
  });

  const commands = useMemo(
    () =>
      buildCommands(
        t,
        {
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
            if (destination !== 'queue') {
              router.push('/');
              return;
            }
            // Wait for the palette to close and give focus back before moving it.
            setTimeout(() => document.getElementById('queue-search')?.focus(), 0);
          },
          signOut: () => {
            void signOut();
          },
          goHome,
          goAdmin,
          goTo,
          openSwitchDialog: (switchKey, on) => {
            setSwitchTarget({ switchKey, on });
          },
        },
        { can, ai: { killOn, capOn } },
      ),
    [t, router, signOut, can, killOn, capOn, goHome, goAdmin, goTo, destination],
  );

  // Owner, 2026-11-02: the floating sheet on a gradient backdrop is for Overview only; every other
  // page is full screen.
  const Frame = destination === 'home' ? AppFrame : FullScreen;
  return (
    <Frame data-hydrated={hydrated} className="md:flex-row">
      <a
        href={skipTo.href}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        {t(skipTo.label)}
      </a>
      <NavRail
        destination={destination}
        expanded={railExpanded}
        onToggleExpanded={toggleRail}
        onOpenPalette={togglePalette}
        onOpenKeymap={() => {
          setHelpOpen(true);
        }}
        isMac={isMac}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <CriticalBanner />
        <AiPausedBanner />
        {children}
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <KeyboardMap open={helpOpen} onOpenChange={setHelpOpen} isMac={isMac} />
      <SwitchConfirmDialog
        target={switchTarget}
        onClose={() => {
          setSwitchTarget(null);
        }}
      />
    </Frame>
  );
}

/** Every page but Overview: the shell fills the window, the rail on the frame ground. */
function FullScreen({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex h-dvh flex-col bg-frame', className)} {...props} />;
}
