'use client';

import type { Alert } from '@watchtower/shared';
import { Button, cn, EmptyState, Kbd, SegmentedControl, TintChip } from '@watchtower/ui';
import { BellRing, Link2Off } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { AlertDetail } from '@/components/ops/alerts/alert-detail';
import { CorrelationGroups, NoiseReport } from '@/components/ops/alerts/alert-insights';
import {
  AlertSeverityBadge,
  AlertSourceText,
  AlertStateChips,
  OpsSkeleton,
} from '@/components/ops/ops-bits';
import { AskAiButton } from '@/components/assistant/ask-ai-button';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useShortcut } from '@/lib/keyboard';
import {
  ALERT_VIEWS,
  alertQueryFor,
  isAlertView,
  stepIndex,
  type AlertView,
} from '@/lib/ops/model';
import { useAlertList, useServices } from '@/lib/ops/queries';

const rowId = (id: string) => `alert-row-${id}`;

export function AlertsPage() {
  return (
    <RequirePermission permission="alert.read" role="lead">
      <AlertsBody />
    </RequirePermission>
  );
}

/**
 * Alerts (R-3.1 to R-3.11): a list on the left, the alert on the right. The view and the open
 * alert are in the address (`?view=` and `?alert=`), so a link to an alert opens it. J and K move
 * through the list, Enter opens the row that has focus, A acknowledges and S snoozes (alert detail).
 */
function AlertsBody() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const viewParam = params.get('view');
  const view: AlertView = isAlertView(viewParam) ? viewParam : 'open';
  const selectedId = params.get('alert');
  const query = alertQueryFor(view);
  const list = useAlertList(query);
  const services = useServices();
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const index = items.findIndex((item) => item.id === selectedId);

  const go = (next: { view?: AlertView; alert?: string | null }) => {
    const search = new URLSearchParams(params.toString());
    if (next.view !== undefined) {
      search.set('view', next.view);
      search.delete('alert');
    }
    if (next.alert !== undefined) {
      if (next.alert === null) search.delete('alert');
      else search.set('alert', next.alert);
    }
    const text = search.toString();
    router.replace(text === '' ? pathname : `${pathname}?${text}`);
  };

  const move = (delta: 1 | -1) => {
    const next = items[stepIndex(index, delta, items.length)];
    if (!next) return;
    go({ alert: next.id });
  };
  useShortcut(
    'j',
    () => {
      move(1);
    },
    query !== null,
  );
  useShortcut(
    'k',
    () => {
      move(-1);
    },
    query !== null,
  );

  // Keyboard focus follows the selection, so J and K can be pressed again and Enter acts on the row.
  useEffect(() => {
    if (selectedId === null) return;
    const row = document.getElementById(rowId(selectedId));
    const active = document.activeElement;
    if (row && active instanceof HTMLElement && active.closest('[data-alert-list]')) row.focus();
  }, [selectedId]);

  const serviceName = (alert: Alert): string | null =>
    services.data?.items.find((item) => item.id === alert.serviceId)?.name ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="sr-only">{t('ops.alerts.title')}</h2>
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl
            aria-label={t('ops.alerts.views.label')}
            value={view}
            onValueChange={(next) => {
              go({ view: next });
            }}
            options={ALERT_VIEWS.map((value) => ({
              value,
              label: t(`ops.alerts.views.${value}`),
            }))}
          />
        </div>
        {query !== null ? (
          <p className="text-xs text-muted-foreground">
            <Kbd>J</Kbd> <Kbd>K</Kbd> {t('ops.alerts.keys.move')} · <Kbd>Enter</Kbd>{' '}
            {t('ops.alerts.keys.open')} · <Kbd>A</Kbd> {t('ops.alerts.keys.ack')} · <Kbd>S</Kbd>{' '}
            {t('ops.alerts.keys.snooze')}
          </p>
        ) : null}
      </div>

      {view === 'groups' ? (
        <CorrelationGroups />
      ) : view === 'noise' ? (
        <NoiseReport />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <section aria-label={t('ops.alerts.listLabel')} className="min-h-0 lg:overflow-y-auto">
            {list.isPending ? (
              <OpsSkeleton rows={6} />
            ) : list.isError ? (
              <LoadError message={t('ops.alerts.loadError')} onRetry={() => void list.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState icon={<BellRing />} tone="teal" title={t(`ops.alerts.empty.${view}`)} />
            ) : (
              <ul data-alert-list className="flex flex-col gap-1.5">
                {items.map((alert) => (
                  <li key={alert.id} className="relative">
                    <AskAiButton
                      entity={{ kind: 'alert', ref: alert.id }}
                      label={alert.title}
                      className="absolute top-1.5 right-1.5 z-10"
                    />
                    <button
                      type="button"
                      id={rowId(alert.id)}
                      aria-current={alert.id === selectedId ? 'true' : undefined}
                      onClick={() => {
                        go({ alert: alert.id });
                      }}
                      className={cn(
                        'flex w-full flex-col gap-1.5 rounded-inner px-3.5 py-2.5 text-left text-sm transition-shadow duration-(--wt-motion-duration-fast) ease-out focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
                        alert.id === selectedId
                          ? 'bg-primary-subtle shadow-lift ring-1 ring-border-strong'
                          : 'hover:bg-surface-muted',
                      )}
                    >
                      <span className="flex flex-wrap items-center gap-1.5">
                        <AlertSeverityBadge severity={alert.severity} />
                        <AlertStateChips alert={alert} />
                      </span>
                      <span className="font-medium break-words">{alert.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <AlertSourceText source={alert.source} />
                        {alert.serviceId === null ? (
                          <TintChip tone="amber" icon={Link2Off}>
                            {t('ops.alerts.unmapped')}
                          </TintChip>
                        ) : (
                          <span>{serviceName(alert) ?? t('ops.alerts.detail.service')}</span>
                        )}
                        <span>{t('ops.alerts.row.count', { count: alert.count })}</span>
                        <RelativeTime iso={alert.lastSeenAt} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {list.hasNextPage ? (
              <div className="pt-2">
                <Button
                  disabled={list.isFetchingNextPage}
                  onClick={() => {
                    void list.fetchNextPage();
                  }}
                >
                  {t('ops.common.loadMore')}
                </Button>
              </div>
            ) : null}
          </section>
          <section
            aria-label={t('ops.alerts.detail.label')}
            className="min-h-0 rounded-card bg-surface p-1.5 shadow-card lg:overflow-y-auto"
          >
            {selectedId === null ? (
              <EmptyState title={t('ops.alerts.detail.select')} />
            ) : (
              <AlertDetail
                key={selectedId}
                alertId={selectedId}
                fallback={items.find((item) => item.id === selectedId)}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
