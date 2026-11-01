'use client';

import { cn, Kbd, TINT_CLASSES, type TintId, Tooltip } from '@watchtower/ui';
import {
  CalendarCheck,
  ClipboardList,
  Command as CommandIcon,
  Gauge,
  Inbox,
  Keyboard,
  type LucideIcon,
  PanelLeft,
  Settings2,
} from 'lucide-react';
import Image from 'next/image';
import type { ReactNode } from 'react';

import { ApiStatus } from '@/components/api-status';
import { AppLink } from '@/components/app-link';
import { LiveStatus } from '@/components/live-status';
import { NotificationCenter } from '@/components/notifications/notification-center';
import { RAIL_ITEM_CLASSES } from '@/components/rail-styles';
import { UserMenu } from '@/components/user-menu';
import { useT } from '@/i18n/provider';
import { adminSectionsFor, HOME_PERMISSION } from '@/lib/admin/sections';
import { useSession } from '@/lib/auth/session';

import { QUEUE_LISTBOX_ID } from '@/components/queue/queue-row';

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
  href,
  tone,
}: {
  /** The hue of the icon: each destination has its own, so the rail reads at a glance. */
  tone?: TintId;
  /** A destination on another route: rendered as a link. */
  href?: string;
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
  const classes = cn(
    RAIL_ITEM_CLASSES,
    'max-md:w-control max-md:justify-center max-md:px-0',
    current
      ? 'bg-primary-subtle font-medium text-foreground'
      : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
    unavailable && 'opacity-60 hover:bg-transparent hover:text-muted-foreground',
    className,
  );
  const content = (
    <>
      <Icon aria-hidden className={cn('size-4 shrink-0', tone && TINT_CLASSES[tone].icon)} />
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
    </>
  );
  return (
    <Tooltip
      content={hint ?? label}
      shortcut={shortcut}
      side="right"
      disabled={expanded && !unavailable}
    >
      {href && !unavailable ? (
        <AppLink
          href={href}
          aria-label={label}
          aria-current={current ? 'page' : undefined}
          aria-keyshortcuts={keyShortcuts}
          className={classes}
        >
          {content}
        </AppLink>
      ) : (
        <button
          type="button"
          aria-label={label}
          aria-current={current ? 'page' : undefined}
          aria-disabled={unavailable || undefined}
          aria-keyshortcuts={keyShortcuts}
          aria-expanded={expandedState}
          onClick={unavailable ? undefined : onClick}
          className={classes}
        >
          {content}
        </button>
      )}
    </Tooltip>
  );
}

export type RailDestination = 'queue' | 'home' | 'admin';

export interface NavRailProps {
  /** The page being shown. */
  destination?: RailDestination;
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
  destination = 'queue',
  expanded: railExpanded,
  onToggleExpanded,
  onOpenPalette,
  onOpenKeymap,
  isMac,
}: NavRailProps) {
  const t = useT();
  const { can } = useSession();
  const handler = can('ticket.handle');
  const canReadTickets = can('ticket.read');
  const showHome = can(HOME_PERMISSION);
  const showAdmin = adminSectionsFor(can).length > 0;
  const adminHref = adminSectionsFor(can)[0]?.href ?? '/admin';
  // Words are only shown from 768px up; on a phone the bar is icons.
  const expanded = railExpanded;
  const mod = isMac ? '⌘' : 'Ctrl';

  return (
    <header
      className={cn(
        'flex h-[48px] shrink-0 items-center gap-1 border-b border-border/60 bg-background px-3',
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
          className="size-7 shrink-0 rounded-xl"
          priority
        />
        <p className={cn('text-base font-semibold', expanded ? 'md:block' : 'md:sr-only')}>
          {t('app.name')}
        </p>
      </div>

      <nav aria-label={t('rail.label')} className="hidden flex-col gap-0.5 md:flex">
        <RailButton
          icon={Inbox}
          tone="teal"
          label={t('rail.queue')}
          expanded={expanded}
          current={destination === 'queue'}
          keyShortcuts="g q"
          {...(destination === 'queue'
            ? {
                onClick: () => {
                  const target =
                    document.getElementById(QUEUE_LISTBOX_ID) ??
                    document.getElementById('pane-queue');
                  target?.focus();
                },
              }
            : { href: '/' })}
        />
        {handler ? (
          <>
            <RailButton
              icon={ClipboardList}
              tone="amber"
              label={t('rail.brief')}
              expanded={expanded}
              unavailable
              hint={`${t('rail.brief')} — ${t('rail.comingSoon')}`}
            />
            <RailButton
              icon={CalendarCheck}
              tone="indigo"
              label={t('rail.handoff')}
              expanded={expanded}
              unavailable
              hint={`${t('rail.handoff')} — ${t('rail.comingSoon')}`}
            />
          </>
        ) : null}
        {canReadTickets ? <NotificationCenter expanded={expanded} /> : null}
        {showHome || showAdmin ? (
          <div
            role="separator"
            aria-orientation="horizontal"
            className="mx-2 my-1 h-px bg-border"
          />
        ) : null}
        {showHome ? (
          <RailButton
            icon={Gauge}
            tone="sky"
            label={t('rail.home')}
            expanded={expanded}
            current={destination === 'home'}
            keyShortcuts="g d"
            href="/home"
          />
        ) : null}
        {showAdmin ? (
          <RailButton
            icon={Settings2}
            tone="violet"
            label={t('rail.admin')}
            expanded={expanded}
            current={destination === 'admin'}
            keyShortcuts="g a"
            href={adminHref}
          />
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
