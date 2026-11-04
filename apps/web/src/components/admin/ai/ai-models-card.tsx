'use client';

import type { AiModelMapping } from '@watchtower/shared';
import { Skeleton, TintChip } from '@watchtower/ui';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { LoadError } from '@/components/admin/admin-page';
import { useI18n } from '@/i18n/provider';
import { useAiModels } from '@/lib/admin/queries';

/**
 * Which model each AI agent runs on, and whether the grader is independent of the drafter
 * (T-301c, ADR-025 condition 7). Read-only: the mapping lives in the environment.
 */
export function AiModelsCard() {
  const { t } = useI18n();
  const models = useAiModels(true);
  return (
    <section aria-labelledby="ai-models-title" className="px-4 pb-2">
      <div className="rounded-2xl bg-surface px-5 py-4 ring-1 ring-border/60 ring-inset">
        {models.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{t('admin.common.loading')}</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10" />
          </div>
        ) : models.isError ? (
          <LoadError
            message={t('admin.ai.models.loadError')}
            onRetry={() => void models.refetch()}
          />
        ) : (
          <ModelsBody mapping={models.data} />
        )}
      </div>
    </section>
  );
}

function ModelsBody({ mapping }: { mapping: AiModelMapping }) {
  const { t } = useI18n();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ai-models-title" className="text-sm font-semibold">
          {t('admin.ai.models.title')}
        </h2>
        <TintChip
          tone={mapping.graderIndependent ? 'teal' : 'amber'}
          icon={mapping.graderIndependent ? CircleCheck : TriangleAlert}
        >
          {mapping.graderIndependent
            ? t('admin.ai.models.independent')
            : t('admin.ai.models.notIndependent')}
        </TintChip>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('admin.ai.models.intro')}</p>
      <ul className="mt-3 flex flex-col divide-y divide-border/60 text-sm">
        {mapping.agents.map((row) => (
          <li key={row.agent} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="font-medium">{row.agent}</span>
            <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <span className="tabular">{row.model ?? t('admin.ai.models.notSet')}</span>
              <span>
                {t('admin.ai.models.tier')} {row.tier} · {t(`admin.ai.models.source.${row.source}`)}
              </span>
              {row.model !== null && !row.priced ? (
                <TintChip tone="amber" icon={TriangleAlert}>
                  {t('admin.ai.models.noPrice')}
                </TintChip>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
