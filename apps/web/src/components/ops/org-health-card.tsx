'use client';

import type { HealthSnapshot } from '@watchtower/shared';
import { Alert } from '@watchtower/ui';

import { LoadError } from '@/components/admin/admin-page';
import { OpsSkeleton } from '@/components/ops/ops-bits';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { useOrgHealth } from '@/lib/ops/queries';

/**
 * The Client Health Score of one organization (R-8.4). Only for someone with `org.health.read`:
 * without it the card renders nothing and asks the api for nothing. When there is not enough data
 * the card says so in words and shows no number at all (N5): a score is never invented, and the
 * weights are said to be an assumption until the owner confirms them.
 */
export function OrgHealthCard({ orgId }: { orgId: string }) {
  const { can } = useSession();
  const allowed = can('org.health.read');
  const { t } = useI18n();
  const health = useOrgHealth(orgId, allowed);
  if (!allowed) return null;
  if (health.isPending) return <OpsSkeleton rows={3} />;
  if (health.isError) return <LoadError onRetry={() => void health.refetch()} />;
  const snapshot = health.data.snapshot;
  return (
    <section aria-labelledby="org-health" className="flex max-w-xl flex-col gap-3">
      <h2 id="org-health" className="text-sm font-semibold">
        {t('ops.health.title')}
      </h2>
      {snapshot === null ? (
        <Alert tone="info" title={t('ops.health.none')}>
          {t('ops.health.noneBody')}
        </Alert>
      ) : (
        <Snapshot snapshot={snapshot} />
      )}
      <p className="text-xs text-muted-foreground">{t('ops.health.assumed')}</p>
    </section>
  );
}

function Snapshot({ snapshot }: { snapshot: HealthSnapshot }) {
  const { t } = useI18n();
  return (
    <>
      {snapshot.status === 'scored' && snapshot.score !== null ? (
        <p>
          <span className="tabular text-3xl font-semibold">{snapshot.score}</span>
          <span className="text-muted-foreground"> / 100</span>
        </p>
      ) : (
        <Alert tone="info" title={t('ops.health.insufficient')}>
          {t('ops.health.insufficientBody')}
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        {t('ops.health.asOf', { day: snapshot.day, version: snapshot.formulaVersion })}
      </p>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('ops.health.components')}</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              {t('ops.health.component')}
            </th>
            <th scope="col" className="px-3 py-1 font-medium">
              {t('ops.health.weight')}
            </th>
            <th scope="col" className="py-1 pl-3 font-medium">
              {t('ops.health.score')}
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshot.components.map((component) => (
            <tr key={component.key} className="border-t border-border">
              <th scope="row" className="py-1 pr-3 font-normal">
                {t(`ops.health.key.${component.key}`)}
              </th>
              <td className="tabular px-3 py-1">{Math.round(component.weight * 100)}%</td>
              <td className="tabular py-1 pl-3">
                {component.status === 'no_data' || component.score === null
                  ? t('ops.health.noData')
                  : component.score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
