'use client';

import { cn } from '@watchtower/ui';
import { ChevronDown, ChevronUp, OctagonAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Notification } from '@watchtower/shared';

import { AppLink } from '@/components/app-link';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { notificationHref } from '@/lib/notifications/describe';
import { useCriticalNotifications, useNotificationMutations } from '@/lib/notifications/queries';

/**
 * Same on the filled P1 surface: outlined, so the colour pair is the one the token tests check
 * (severity p1 foreground on background) and a focus ring of that same foreground.
 */
const BUTTON =
  'inline-flex h-8 items-center gap-1 rounded-md border border-sev-p1-border px-3 text-sm font-medium text-sev-p1-fg hover:bg-sev-p1-fg/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sev-p1-fg';

/** Puts `(P1)` in front of the tab title while the banner is up, and takes it away after. */
function useTabPrefix(active: boolean, prefix: string): void {
  useEffect(() => {
    if (!active) return undefined;
    const original = document.title;
    if (!original.startsWith(prefix)) document.title = `${prefix} ${original}`;
    return () => {
      document.title = original;
    };
  }, [active, prefix]);
}

function Row({ item, onAcknowledge }: { item: Notification; onAcknowledge: (id: string) => void }) {
  const { t } = useI18n();
  const key = item.ticket?.key ?? '';
  const href = notificationHref(item);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="critical-item">
      <p className="min-w-0 flex-1 basis-60 text-sm">
        <span className="font-semibold">{key}</span>
        {item.ticket ? <span> {item.ticket.subject}</span> : null}
        <span>
          {' '}
          — {t('notifications.banner.notAcknowledged')} <RelativeTime iso={item.createdAt} />
        </span>
      </p>
      <div className="flex shrink-0 gap-2">
        {href ? (
          <AppLink
            href={href}
            aria-label={t('notifications.banner.openNamed', { key })}
            onClick={() => {
              onAcknowledge(item.id);
            }}
            className={BUTTON}
          >
            {t('notifications.banner.open')}
          </AppLink>
        ) : null}
        <button
          type="button"
          aria-label={t('notifications.banner.acknowledgeNamed', { key })}
          onClick={() => {
            onAcknowledge(item.id);
          }}
          className={BUTTON}
        >
          {t('notifications.banner.acknowledge')}
        </button>
      </div>
    </div>
  );
}

/**
 * The sticky critical banner under the top of the app (docs/06-UI-SPEC.md section 8.1): shown while
 * the signed-in person has an unread P1 notification. Filled P1 tokens, the octagon icon and the
 * words "P1 Critical", so it does not rely on red. It cannot be dismissed, only acknowledged (which
 * marks the notification read) or opened (which does the same); one banner at a time, with the
 * others behind "+N more P1". It appears without animation, never flashes, and the tab title gets
 * a `(P1)` prefix. Phase 1 has no sound and no Web Push, so a person who is not looking at the tab
 * is not reached `[ASSUMED]`.
 */
export function CriticalBanner() {
  const { t } = useI18n();
  const { can } = useSession();
  const critical = useCriticalNotifications(can('ticket.read'));
  const { markRead } = useNotificationMutations();
  const [expanded, setExpanded] = useState(false);
  const items = critical.data ?? [];
  useTabPrefix(items.length > 0, t('notifications.banner.tabPrefix'));
  const first = items[0];
  if (first === undefined) return null;

  const rest = items.slice(1);
  const acknowledge = (id: string) => {
    markRead.mutate(id);
  };
  return (
    <div
      role="alert"
      aria-label={t('notifications.banner.label')}
      data-testid="critical-banner"
      className={cn(
        'sticky top-0 z-30 shrink-0 border-b border-sev-p1-border bg-sev-p1-bg px-3 py-2 text-sev-p1-fg',
      )}
    >
      <div className="flex items-start gap-2.5">
        <OctagonAlert aria-hidden className="mt-0.5 size-5 shrink-0" strokeWidth={2} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-semibold">{t('notifications.banner.title')}</p>
          <Row item={first} onAcknowledge={acknowledge} />
          {rest.length > 0 ? (
            <>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls="critical-more"
                onClick={() => {
                  setExpanded((value) => !value);
                }}
                className="inline-flex items-center gap-1 rounded-sm text-sm font-medium underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sev-p1-fg"
              >
                {expanded ? (
                  <ChevronUp aria-hidden className="size-4" />
                ) : (
                  <ChevronDown aria-hidden className="size-4" />
                )}
                {t('notifications.banner.moreCount', { count: rest.length })}
                <span className="sr-only">
                  {' '}
                  — {t(expanded ? 'notifications.banner.hideAll' : 'notifications.banner.showAll')}
                </span>
              </button>
              <div
                id="critical-more"
                role="group"
                aria-label={t('notifications.banner.list')}
                hidden={!expanded}
                className="space-y-1.5 border-t border-sev-p1-border pt-1.5"
              >
                {rest.map((item) => (
                  <Row key={item.id} item={item} onAcknowledge={acknowledge} />
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
