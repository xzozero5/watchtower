'use client';

import { Alert } from '@watchtower/ui';

import { LoadError } from '@/components/admin/admin-page';
import { Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { useI18n } from '@/i18n/provider';
import { useIncidentChanges } from '@/lib/ops/queries';

/**
 * "What changed" before the first alert (R-3.15): deploys from the feed, and commits, pull requests
 * and releases when a repository is connected. The panel says where the repository data came from
 * (`none`, `fake`, `live`) and that a repository that could not be read leaves the deploys intact,
 * so a missing list is never mistaken for "nothing changed".
 */
export function ChangesPanel({ incidentId }: { incidentId: string }) {
  const { t } = useI18n();
  const changes = useIncidentChanges(incidentId, true);
  if (changes.isPending) return <OpsSkeleton rows={3} />;
  if (changes.isError) return <LoadError onRetry={() => void changes.refetch()} />;
  const data = changes.data;
  return (
    <section aria-label={t('ops.incidents.tabs.changes')} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {t(
          data.window.endsAt === 'alert'
            ? 'ops.incidents.changes.windowAlert'
            : 'ops.incidents.changes.windowIncident',
          {
            minutes: data.window.minutes,
          },
        )}{' '}
        <Moment iso={data.window.from} /> – <Moment iso={data.window.to} />
      </p>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold">
          {t('ops.incidents.changes.deploys', { count: data.deploys.length })}
        </h3>
        {data.deploys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.changes.noDeploys')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {data.deploys.map((deploy) => (
              <li key={deploy.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                <p className="font-medium break-words">
                  {deploy.serviceSlug} · {deploy.version} · {deploy.env}
                </p>
                <p className="text-muted-foreground">
                  <Moment iso={deploy.occurredAt} />
                  {deploy.actor ? ` · ${deploy.actor}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold">{t('ops.incidents.changes.repo')}</h3>
        {data.repoSource === 'none' ? (
          <p className="text-sm text-muted-foreground">{t('ops.incidents.changes.repoNone')}</p>
        ) : (
          <>
            {data.repoSource === 'fake' ? (
              <Alert tone="info" title={t('ops.incidents.changes.repoFake')} />
            ) : null}
            {data.repoUnavailable ? (
              <Alert tone="error" title={t('ops.incidents.changes.repoUnavailable')} />
            ) : data.repoChanges.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('ops.incidents.changes.noRepoChanges')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.repoChanges.map((change) => (
                  <li
                    key={`${change.repo}-${change.kind}-${change.ref}`}
                    className="rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <p className="font-medium break-words">
                      {t(`ops.incidents.changes.kind.${change.kind}`)} {change.ref}
                      {change.title ? ` · ${change.title}` : ''}
                    </p>
                    <p className="text-muted-foreground">
                      {change.repo} · <Moment iso={change.at} />
                      {change.author ? ` · ${change.author}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
