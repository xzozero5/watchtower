'use client';

import { Button, cn, EmptyState, Kbd, SegmentedControl } from '@watchtower/ui';
import { Plus, Siren } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { LoadError, RequirePermission } from '@/components/admin/admin-page';
import { CreateIncidentDialog } from '@/components/ops/incidents/create-incident-dialog';
import { AskAiButton } from '@/components/assistant/ask-ai-button';
import { IncidentDetailView } from '@/components/ops/incidents/incident-detail';
import { IncidentSeverityBadge, IncidentStatusChip, OpsSkeleton } from '@/components/ops/ops-bits';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useShortcut } from '@/lib/keyboard';
import { stepIndex } from '@/lib/ops/model';
import { useIncidentList } from '@/lib/ops/queries';

const rowId = (id: string) => `incident-row-${id}`;
type Scope = 'open' | 'all';

export function IncidentsPage() {
  return (
    <RequirePermission permission="ticket.read" role="lead">
      <IncidentsBody />
    </RequirePermission>
  );
}

/**
 * Incidents (R-3.12): open ones first by default, the whole history one choice away. The incident
 * open on the right is in the address (`?incident=`). J and K move through the list.
 */
function IncidentsBody() {
  const { t } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const scope: Scope = params.get('scope') === 'all' ? 'all' : 'open';
  const selectedId = params.get('incident');
  const list = useIncidentList(scope === 'open' ? { open: true } : {});
  const items = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const index = items.findIndex((item) => item.id === selectedId);
  const [creating, setCreating] = useState(false);

  const go = (next: { scope?: Scope; incident?: string }) => {
    const search = new URLSearchParams(params.toString());
    if (next.scope !== undefined) {
      search.set('scope', next.scope);
      search.delete('incident');
    }
    if (next.incident !== undefined) search.set('incident', next.incident);
    router.replace(`${pathname}?${search.toString()}`);
  };
  const move = (delta: 1 | -1) => {
    const next = items[stepIndex(index, delta, items.length)];
    if (!next) return;
    go({ incident: next.id });
    document.getElementById(rowId(next.id))?.focus();
  };
  useShortcut('j', () => {
    move(1);
  });
  useShortcut('k', () => {
    move(-1);
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="sr-only">{t('ops.incidents.title')}</h2>
        <SegmentedControl
          aria-label={t('ops.incidents.scope.label')}
          value={scope}
          onValueChange={(next) => {
            go({ scope: next });
          }}
          options={[
            { value: 'open', label: t('ops.incidents.scope.open') },
            { value: 'all', label: t('ops.incidents.scope.all') },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          <Kbd>J</Kbd> <Kbd>K</Kbd> {t('ops.alerts.keys.move')}
        </p>
        {can('incident.create') ? (
          <Button
            className="ml-auto"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden className="size-4" />
            {t('ops.incidents.new')}
          </Button>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <section aria-label={t('ops.incidents.listLabel')} className="min-h-0 lg:overflow-y-auto">
          {list.isPending ? (
            <OpsSkeleton rows={5} />
          ) : list.isError ? (
            <LoadError message={t('ops.incidents.loadError')} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<Siren />}
              tone="teal"
              title={t(scope === 'open' ? 'ops.incidents.emptyOpen' : 'ops.incidents.emptyAll')}
            />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {items.map((incident) => (
                <li key={incident.id} className="relative">
                  <AskAiButton
                    entity={{ kind: 'incident', ref: incident.id }}
                    label={incident.key}
                    className="absolute top-1.5 right-1.5 z-10"
                  />
                  <button
                    type="button"
                    id={rowId(incident.id)}
                    aria-current={incident.id === selectedId ? 'true' : undefined}
                    onClick={() => {
                      go({ incident: incident.id });
                    }}
                    className={cn(
                      'flex w-full flex-col gap-1.5 rounded-inner px-3.5 py-2.5 text-left text-sm transition-shadow duration-(--wt-motion-duration-fast) ease-out focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring',
                      incident.id === selectedId
                        ? 'bg-primary-subtle shadow-lift ring-1 ring-border-strong'
                        : 'hover:bg-surface-muted',
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <IncidentSeverityBadge severity={incident.severity} />
                      <IncidentStatusChip status={incident.status} />
                    </span>
                    <span className="font-medium break-words">
                      {incident.key} · {incident.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <RelativeTime iso={incident.startedAt} />
                      <span>
                        {t('ops.incidents.detail.countsValue', {
                          tickets: incident.tickets,
                          alerts: incident.alerts,
                        })}
                      </span>
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
          aria-label={t('ops.incidents.detail.label')}
          className="min-h-0 rounded-card bg-surface p-1.5 shadow-card lg:overflow-y-auto"
        >
          {selectedId === null ? (
            <EmptyState title={t('ops.incidents.detail.select')} />
          ) : (
            <IncidentDetailView key={selectedId} incidentId={selectedId} />
          )}
        </section>
      </div>
      <CreateIncidentDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
