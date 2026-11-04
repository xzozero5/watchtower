'use client';

import type { WeeklyBrief } from '@watchtower/shared';
import { Button, SectionHeading, Skeleton, TintChip } from '@watchtower/ui';
import { FileText, Pencil } from 'lucide-react';

import { AppLink } from '@/components/app-link';
import { ClaimLine } from '@/components/claims/claim-line';
import { LoadError } from '@/components/admin/admin-page';
import { useI18n } from '@/i18n/provider';
import { useSession } from '@/lib/auth/session';
import { formatDateTime } from '@/lib/format';
import { useWeeklyBrief, useWeeklyBriefDraft } from '@/lib/reports/queries';

/** The day of an ISO time as `YYYY-MM-DD`: the period of a brief is whole days, so a clock would only add noise. */
const dayOf = (iso: string): string => iso.slice(0, 10);

/** Who wrote what, in words and icons (never colour alone): AI, edited by the head, figures only, demo. */
export function BriefBadges({ brief }: { brief: WeeklyBrief }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {brief.source === 'data_only' ? (
        <TintChip tone="slate" title={t('reports.brief.badge.figuresOnlyTip')}>
          {t('reports.brief.badge.figuresOnly')}
        </TintChip>
      ) : (
        <TintChip tone="sky">{t('reports.brief.badge.ai')}</TintChip>
      )}
      {brief.editedAt === null ? null : (
        <TintChip tone="teal">{t('reports.brief.badge.edited')}</TintChip>
      )}
      {brief.mock ? (
        <TintChip tone="slate" title={t('reports.brief.badge.demoTip')}>
          {t('reports.brief.badge.demo')}
        </TintChip>
      ) : null}
    </span>
  );
}

/**
 * The text of a brief: this week, the top root causes, the decisions needed. Every sentence is a `ClaimLine`
 * (its evidence as chips, or the words "No evidence"), so no AI sentence is shown as a bare fact (T-135, N5).
 * An empty section says it is empty rather than disappearing.
 */
export function BriefBody({ brief }: { brief: WeeklyBrief }) {
  const { t } = useI18n();
  const { content } = brief;
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="brief-summary" className="flex flex-col gap-2">
        <h3 id="brief-summary" className="text-sm font-medium text-foreground-strong">
          {t('reports.brief.section.summary')}
        </h3>
        {content.summary.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('reports.brief.noSummary')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {content.summary.map((claim, index) => (
              <ClaimLine key={`${String(index)}-${claim.text}`} claim={claim} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="brief-causes" className="flex flex-col gap-2">
        <h3 id="brief-causes" className="text-sm font-medium text-foreground-strong">
          {t('reports.brief.section.rootCauses')}
        </h3>
        {content.rootCauses.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('reports.brief.noRootCauses')}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {content.rootCauses.map((cause, index) => (
              <li key={`${String(index)}-${cause.title}`} className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">
                  {String(index + 1)}. {cause.title}
                </p>
                <ul className="flex flex-col gap-2 pl-4">
                  {cause.claims.map((claim, claimIndex) => (
                    <ClaimLine key={`${String(claimIndex)}-${claim.text}`} claim={claim} />
                  ))}
                </ul>
                {cause.ask === null ? null : (
                  <p className="pl-4 text-sm">
                    <span className="font-medium" title={t('reports.brief.askTip')}>
                      {t('reports.brief.ask')}:
                    </span>{' '}
                    {cause.ask}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="brief-decisions" className="flex flex-col gap-2">
        <h3 id="brief-decisions" className="text-sm font-medium text-foreground-strong">
          {t('reports.brief.section.decisions')}
        </h3>
        {content.decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('reports.brief.noDecisions')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {content.decisions.map((claim, index) => (
              <ClaimLine key={`${String(index)}-${claim.text}`} claim={claim} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The weekly brief on the CEO view (T-305c, PRD 9.2): the newest published one, with who wrote what; for a
 * head, a pointer to a draft that waits to be reviewed. Lead and head read it; only the head edits.
 */
export function WeeklyBriefCard() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const canEdit = can('metric.manage');
  const published = useWeeklyBrief(true);
  const draft = useWeeklyBriefDraft(canEdit);
  const brief = published.data?.brief ?? null;
  const waiting = draft.data?.draft ?? null;

  return (
    <section aria-labelledby="ceo-brief" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ceo-brief" className="text-title font-medium text-foreground-strong">
          <SectionHeading tone="violet" icon={FileText} plain>
            {t('reports.brief.title')}
          </SectionHeading>
        </h2>
        {canEdit ? (
          <Button asChild size="sm">
            <AppLink href="/dashboard/ceo/brief">
              <Pencil aria-hidden className="size-4" />
              {t('reports.brief.review')}
            </AppLink>
          </Button>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{t('reports.brief.lead')}</p>
      {canEdit && waiting !== null ? (
        <p role="status" className="text-sm font-medium">
          {t('reports.brief.draftReady')}
        </p>
      ) : null}
      {published.isError && !published.data ? (
        <LoadError
          message={t('reports.brief.loadError')}
          onRetry={() => void published.refetch()}
          className="px-0 py-0"
        />
      ) : published.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">{t('reports.brief.loading')}</span>
          <Skeleton className="h-32 rounded-card" />
        </div>
      ) : brief === null ? (
        <p className="rounded-card bg-surface px-5 py-4 text-sm shadow-card">
          {t('reports.brief.empty')}
        </p>
      ) : (
        <article className="flex max-w-3xl flex-col gap-4 rounded-card bg-surface px-5 py-4 shadow-card">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t('reports.brief.period', {
                from: dayOf(brief.periodFrom),
                to: dayOf(brief.periodTo),
              })}
            </span>
            {brief.publishedAt === null ? null : (
              <span>
                {t('reports.brief.publishedOn', {
                  date: formatDateTime(brief.publishedAt, locale),
                })}
              </span>
            )}
            <BriefBadges brief={brief} />
          </header>
          <BriefBody brief={brief} />
        </article>
      )}
    </section>
  );
}
