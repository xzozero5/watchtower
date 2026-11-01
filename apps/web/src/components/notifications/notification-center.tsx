'use client';

import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SeverityBadge,
  Skeleton,
  TINT_CLASSES,
  Tooltip,
} from '@watchtower/ui';
import { Bell, Settings2 } from 'lucide-react';
import { useState } from 'react';
import {
  NOTIFICATION_KINDS,
  isMandatoryNotification,
  type Notification,
  type NotificationKind,
} from '@watchtower/shared';

import { AppLink } from '@/components/app-link';
import { RelativeTime } from '@/components/relative-time';
import { RAIL_ITEM_CLASSES } from '@/components/rail-styles';
import { useI18n } from '@/i18n/provider';
import {
  isSameDay,
  kindMessageKey,
  kindNameKey,
  kindValues,
  notificationHref,
} from '@/lib/notifications/describe';
import {
  useNotificationMutations,
  useNotificationPreferences,
  useNotifications,
  useSetNotificationPreferences,
} from '@/lib/notifications/queries';
import { useNow } from '@/lib/use-now';

/** The badge stops counting here: "99+" is as much as anyone can act on. */
const BADGE_MAX = 99;

function NotificationRow({ item, onOpen }: { item: Notification; onOpen: () => void }) {
  const { t } = useI18n();
  const { markRead } = useNotificationMutations();
  const href = notificationHref(item);
  const unread = item.readAt === null;
  const text = t(kindMessageKey(item.kind), kindValues(item));
  const body = (
    <>
      {item.severity === 'critical' ? (
        <SeverityBadge severity="p1" label={t('severity.p1')} hideLabel className="mr-1.5" />
      ) : null}
      <span className={cn('min-w-0', unread && 'font-medium')}>{text}</span>
      {item.ticket ? (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {item.ticket.subject}
        </span>
      ) : null}
    </>
  );
  return (
    <li
      data-testid="notification-item"
      data-unread={unread}
      className="flex items-start gap-2 border-b border-border px-3 py-2.5 last:border-b-0"
    >
      <span
        aria-hidden
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-link' : 'bg-transparent')}
      />
      <div className="min-w-0 flex-1 text-sm">
        {href ? (
          <AppLink
            href={href}
            onClick={() => {
              if (unread) markRead.mutate(item.id);
              onOpen();
            }}
            className="block rounded-sm text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {body}
          </AppLink>
        ) : (
          <p>{body}</p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {unread ? <span className="sr-only">{t('notifications.center.unread')}. </span> : null}
          <RelativeTime iso={item.createdAt} />
        </p>
      </div>
      {unread ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            markRead.mutate(item.id);
          }}
          className="shrink-0"
        >
          {t('notifications.center.markRead')}
          <span className="sr-only"> {text}</span>
        </Button>
      ) : null}
    </li>
  );
}

function Preferences() {
  const { t } = useI18n();
  const prefs = useNotificationPreferences(true);
  const save = useSetNotificationPreferences();
  const choice = (kind: NotificationKind) =>
    prefs.data?.preferences.find((entry) => entry.kind === kind)?.inApp ?? true;
  return (
    <section aria-labelledby="notification-settings" className="border-b border-border px-3 py-2.5">
      <h3 id="notification-settings" className="text-sm font-medium">
        {t('notifications.center.settingsTitle')}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t('notifications.center.settingsHint')}
      </p>
      <ul className="mt-2 space-y-1.5">
        {NOTIFICATION_KINDS.map((kind) => {
          const mandatory = isMandatoryNotification(kind);
          const id = `notification-pref-${kind}`;
          return (
            <li key={kind} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                checked={choice(kind)}
                disabled={mandatory || prefs.isPending || save.isPending}
                onChange={(event) => {
                  save.mutate({ preferences: [{ kind, inApp: event.target.checked }] });
                }}
                className="size-4 accent-primary"
              />
              <label htmlFor={id}>
                {t(kindNameKey(kind))}
                {mandatory ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    ({t('notifications.center.alwaysOn')})
                  </span>
                ) : null}
              </label>
            </li>
          );
        })}
      </ul>
      {save.isError ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {t('notifications.center.saveError')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The bell of the navigation rail and its panel (docs/06-UI-SPEC.md section 8.2): the newest
 * notifications of the signed-in person, grouped into today and earlier, each linking to its
 * ticket, with "Mark all read" and the per-kind settings. The count on the bell is text as well as
 * a badge, so it does not depend on colour. A P1 is also pinned in the sticky banner until read.
 */
export function NotificationCenter({ expanded }: { expanded: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const list = useNotifications(true);
  const { markAllRead } = useNotificationMutations();
  const now = useNow();

  const unread = list.data?.unreadCount ?? 0;
  const label =
    unread > 0
      ? t('notifications.center.openLabelUnread', { count: unread })
      : t('notifications.center.openLabel');
  const items = list.data?.items ?? [];
  const today = items.filter((item) => isSameDay(new Date(item.createdAt), new Date(now)));
  const earlier = items.filter((item) => !isSameDay(new Date(item.createdAt), new Date(now)));
  const badge = unread > BADGE_MAX ? `${String(BADGE_MAX)}+` : String(unread);

  const group = (title: string, rows: Notification[]) =>
    rows.length === 0 ? null : (
      <section aria-label={title}>
        <h3 className="bg-surface-muted px-3 py-1 text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        <ul>
          {rows.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              onOpen={() => {
                setOpen(false);
              }}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={label} side="right" disabled={expanded}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            data-testid="notification-bell"
            className={cn(
              RAIL_ITEM_CLASSES,
              'max-md:w-control max-md:justify-center max-md:px-0',
              open
                ? 'bg-primary-subtle font-medium text-foreground'
                : 'text-muted-foreground hover:bg-surface-muted hover:text-foreground',
            )}
          >
            <span className="relative shrink-0">
              <Bell aria-hidden className={cn('size-4', TINT_CLASSES.pink.icon)} />
              {unread > 0 ? (
                <span
                  aria-hidden
                  data-testid="notification-badge"
                  className="absolute -top-2 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
                >
                  {badge}
                </span>
              ) : null}
            </span>
            <span aria-hidden className={cn('truncate', !expanded && 'sr-only', 'max-md:sr-only')}>
              {t('notifications.center.title')}
            </span>
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="right"
        align="end"
        aria-label={t('notifications.center.title')}
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="mr-auto text-sm font-semibold">{t('notifications.center.title')}</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={unread === 0 || markAllRead.isPending}
            onClick={() => {
              markAllRead.mutate();
            }}
          >
            {t('notifications.center.markAllRead')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={settings}
            onClick={() => {
              setSettings((value) => !value);
            }}
          >
            <Settings2 aria-hidden className="size-4" />
            {t('notifications.center.settings')}
          </Button>
        </header>
        {settings ? <Preferences /> : null}
        <div className="max-h-[min(28rem,70dvh)] overflow-y-auto" data-testid="notification-list">
          {list.isPending ? (
            <div role="status" className="space-y-2 p-3">
              <span className="sr-only">{t('notifications.center.loading')}</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : list.isError ? (
            <div role="alert" className="space-y-2 p-3 text-sm">
              <p>{t('notifications.center.error')}</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void list.refetch();
                }}
              >
                {t('notifications.center.retry')}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {t('notifications.center.empty')}
            </p>
          ) : (
            <>
              {group(t('notifications.center.today'), today)}
              {group(t('notifications.center.earlier'), earlier)}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
