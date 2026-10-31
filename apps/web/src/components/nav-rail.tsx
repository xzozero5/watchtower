'use client';

import { cn, Kbd, Tooltip } from '@watchtower/ui';
import {
  Bell,
  CalendarCheck,
  ClipboardList,
  Command as CommandIcon,
  Inbox,
  Keyboard,
  type LucideIcon,
  PanelLeft,
} from 'lucide-react';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { ApiStatus } from '@/components/api-status';
import { LiveStatus } from '@/components/live-status';
import { UserMenu } from '@/components/user-menu';
import { useT } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';

import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';

const ITEM =
  'flex h-control w-full items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-(--wt-motion-duration-fast) ease-out focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring';

/** One icon (plus its words when the rail is expanded) with a tooltip while it is narrow. */
function RailButton({
  icon: Icon,
  label,
  expanded,
  shortcut,
  current = false,
  unavailable = false,
  onClick,
  keyShortcuts,
  expandedState,
  className,
  hint,
  shortLabel,
}: {
  icon: LucideIcon;
  label: string;
  /** What the expanded rail shows when the full name is too long for 220px; the name stays full. */
  shortLabel?: string;
  expanded: boolean;
  shortcut?: readonly string[];
  current?: boolean;
  /** A destination that is not built yet: focusable, announced as disabled, says so in its tooltip. */
  unavailable?: boolean;
  onClick?: () => void;
  keyShortcuts?: string;
  expandedState?: boolean;
  className?: string;
  hint?: ReactNode;
}) {
  return (
    <Tooltip
      content={hint ?? label}
      shortcut={shortcut}
      side="right"
      disabled={expanded && !unavailable}
    >
      <button
        type="button"
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        aria-disabled={unavailable || undefined}
        aria-keyshortcuts={keyShortcuts}
        aria-expanded={expandedState}
        onClick={unavailable ? undefined : onClick}
        className={cn(
          ITEM,
          'max-md:w-control max-md:justify-center max-md:px-0',
          current
            ? 'bg-primary-subtle font-medium text-foreground'
            : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
          unavailable && 'opacity-60 hover:bg-transparent hover:text-muted-foreground',
          className,
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span
          aria-hidden={shortLabel ? true : undefined}
          className={cn('truncate', !expanded && 'sr-only', 'max-md:sr-only')}
        >
          {shortLabel ?? label}
        </span>
        {expanded && shortcut ? (
          <span className="ml-auto flex gap-0.5 max-md:hidden">
            {shortcut.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}

export interface NavRailProps {
  expanded: boolean;
  onToggleExpanded: () => void;
  onOpenPalette: () => void;
  onOpenKeymap: () => void;
  isMac: boolean;
}

/**
 * The navigation rail (docs/design/ui-refresh-2026-11.md section 3.1): 56px of icons with tooltips,
 * 220px with words after Ctrl/Cmd+B. It replaces the top bar: the brand, the destinations, the
 * command palette and the keyboard map at the top and middle; live and API status, the expand
 * switch and the account menu at the foot. Below 768px it is a 48px bar across the top with the
 * palette, the status icons and the account menu.
 */
export function NavRail({
  expanded: railExpanded,
  onToggleExpanded,
  onOpenPalette,
  onOpenKeymap,
  isMac,
}: NavRailProps) {
  const t = useT();
  const { can } = useSession();
  const handler = can('ticket.handle');
  // Words are only shown from 768px up; on a phone the bar is icons.
  const expanded = railExpanded;
  const mod = isMac ? '⌘' : 'Ctrl';

  return (
    <header
      className={cn(
        'flex h-[48px] shrink-0 items-center gap-1 border-b border-border bg-background px-3',
        'md:h-auto md:flex-col md:items-stretch md:gap-0.5 md:border-r md:border-b-0 md:px-2 md:py-3',
        expanded ? 'md:w-[220px]' : 'md:w-[56px]',
      )}
    >
      <div className="flex items-center gap-2.5 md:mb-3 md:px-1.5">
        {/* The name sits next to it as text, so the icon adds nothing for a screen reader. */}
        <Image
          src="/brand/watchtower-icon.png"
          alt=""
          width={28}
          height={28}
          className="size-7 shrink-0 rounded-md"
          priority
        />
        <p className={cn('text-base font-semibold', expanded ? 'md:block' : 'md:sr-only')}>
          {t('app.name')}
        </p>
      </div>

      <nav aria-label={t('rail.label')} className="hidden flex-col gap-0.5 md:flex">
        <RailButton
          icon={Inbox}
          label={t('rail.queue')}
          expanded={expanded}
          current
          keyShortcuts="g q"
          onClick={() => {
            const target =
              document.getElementById(QUEUE_LISTBOX_ID) ?? document.getElementById('pane-queue');
            target?.focus();
          }}
        />
        {handler ? (
          <>
            <RailButton
              icon={ClipboardList}
              label={t('rail.brief')}
              expanded={expanded}
              unavailable
              hint={`${t('rail.brief')} — ${t('rail.comingSoon')}`}
            />
            <RailButton
              icon={CalendarCheck}
              label={t('rail.handoff')}
              expanded={expanded}
              unavailable
              hint={`${t('rail.handoff')} — ${t('rail.comingSoon')}`}
            />
            <RailButton
              icon={Bell}
              label={t('rail.notifications')}
              expanded={expanded}
              unavailable
              hint={`${t('rail.notifications')} — ${t('rail.comingSoon')}`}
            />
          </>
        ) : null}
      </nav>

      <div className="ml-auto flex items-center gap-1 md:mt-auto md:ml-0 md:flex-col md:items-stretch md:gap-0.5">
        <RailButton
          icon={CommandIcon}
          label={t('topbar.openPalette')}
          shortLabel={t('rail.paletteShort')}
          expanded={expanded}
          shortcut={[mod, 'K']}
          keyShortcuts="Control+K Meta+K"
          onClick={onOpenPalette}
        />
        <RailButton
          icon={Keyboard}
          label={t('topbar.openKeymap')}
          shortLabel={t('rail.keymapShort')}
          expanded={expanded}
          shortcut={['?']}
          keyShortcuts="?"
          onClick={onOpenKeymap}
          className="max-md:hidden"
        />
        <div
          className={cn(
            'flex items-center gap-0.5 md:my-1 md:flex-col md:items-stretch',
            expanded && 'md:items-start md:px-1',
          )}
        >
          <LiveStatus compact={!expanded} />
          <ApiStatus compact={!expanded} />
        </div>
        <RailButton
          icon={PanelLeft}
          label={t(expanded ? 'rail.collapse' : 'rail.expand')}
          shortLabel={expanded ? t('rail.collapseShort') : undefined}
          expanded={expanded}
          shortcut={[mod, 'B']}
          keyShortcuts="Control+B Meta+B"
          expandedState={expanded}
          onClick={onToggleExpanded}
          className="max-md:hidden"
        />
        <UserMenu onShowShortcuts={onOpenKeymap} showLabel={expanded} />
      </div>
    </header>
  );
}
