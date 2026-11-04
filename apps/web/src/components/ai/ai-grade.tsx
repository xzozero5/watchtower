'use client';

import type { ResolutionClass, TicketGrade } from '@watchtower/shared';
import { Button, Skeleton, TintChip, type TintId } from '@watchtower/ui';
import { BookOpenCheck, CircleCheck, CircleHelp, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ClaimLine } from '@/components/claims/claim-line';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { useTicketGrade } from '@/lib/ai/grade-queries';
import { formatRate } from '@/lib/dashboard/format';

/**
 * Icon, tint and words per class. The words and the icon shape carry the meaning; the tint is a third cue,
 * never the only one (N5, WCAG 1.4.1). `assumed` is amber and reads as "not confirmed", not as an error.
 */
export const CLASS_LOOK: Record<ResolutionClass, { icon: LucideIcon; tone: TintId }> = {
  verified: { icon: ShieldCheck, tone: 'green' },
  contained: { icon: CircleCheck, tone: 'sky' },
  assumed: { icon: CircleHelp, tone: 'amber' },
};

export function ClassChip({ value }: { value: ResolutionClass }) {
  const { t } = useI18n();
  const look = CLASS_LOOK[value];
  return (
    <TintChip tone={look.tone} icon={look.icon} title={t(`grade.classTip.${value}`)}>
      {t(`grade.class.${value}`)}
    </TintChip>
  );
}

/** The result of the grader for one ticket, as the body of the card (no data fetching here). */
export function AiGradeBody({ grade }: { grade: TicketGrade }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ClassChip value={grade.resolutionClass} />
        {grade.mock ? (
          <TintChip tone="slate" title={t('grade.demoTip')}>
            {t('grade.demo')}
          </TintChip>
        ) : null}
        {grade.csat ? (
          <span className="text-xs text-muted-foreground">
            {t('grade.card.csat', { score: grade.csat.score })}
            {grade.csat.resolved === null
              ? ''
              : ` ${grade.csat.resolved ? t('grade.card.csatResolved') : t('grade.card.csatNotResolved')}`}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {t('grade.card.graded', { time: '' })}
          <RelativeTime iso={grade.gradedAt} />
        </span>
      </div>

      <section aria-label={t('grade.card.why')} className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t('grade.card.why')}</h4>
        {grade.reasons.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('grade.card.noReasons')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {grade.reasons.map((claim, index) => (
              <ClaimLine key={`${claim.text}-${String(index)}`} claim={claim} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('grade.card.draft')} className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">{t('grade.card.draft')}</h4>
        <p className="text-sm text-foreground">
          {t(`grade.card.verdict.${grade.draftVerdict}`)}
          {grade.draftQuality === null ? null : (
            <span className="text-muted-foreground">
              {' · '}
              {t('grade.card.quality', { value: formatRate(grade.draftQuality, locale) })}
            </span>
          )}
        </p>
      </section>

      <section aria-label={t('grade.card.violations')} className="flex flex-col gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t('grade.card.violations')}</h4>
        {grade.violations.length === 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-foreground">
            <ShieldCheck aria-hidden className="size-4 shrink-0 text-tint-green-icon" />
            {t('grade.card.noViolations')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {grade.violations.map((violation, index) => (
              <li key={`${violation.code}-${String(index)}`} className="flex flex-col gap-1">
                <span>
                  <TintChip tone="red" icon={ShieldAlert}>
                    {t(`grade.card.violationCode.${violation.code}`)}
                  </TintChip>
                </span>
                <ul>
                  <ClaimLine
                    claim={{
                      text: violation.text,
                      evidence: violation.evidence,
                      uncited: violation.uncited,
                    }}
                  />
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('grade.card.kbGap')} className="flex flex-col gap-1">
        {grade.kbGap ? (
          <>
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <BookOpenCheck aria-hidden className="size-4 shrink-0 text-tint-amber-icon" />
              {t('grade.card.kbGap')}
            </p>
            <p className="text-sm text-muted-foreground">{t('grade.card.kbGapBody')}</p>
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <BookOpenCheck aria-hidden className="size-4 shrink-0" />
            {t('grade.card.noKbGap')}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The grader's result in the AI sidebar of a resolved ticket (T-301d, PRD 6.2). It asks the api only when
 * the ticket is resolved or closed. Loading, "not graded yet" and a failure each say so: nothing is drawn in
 * place of a verdict that is not there (N5).
 */
export function AiGradeCard({ ticketKey, enabled }: { ticketKey: string; enabled: boolean }) {
  const { t } = useI18n();
  const query = useTicketGrade(ticketKey, enabled);
  if (!enabled) return null;
  return (
    <section
      aria-label={t('grade.card.title')}
      aria-busy={query.isPending || undefined}
      data-testid="ai-grade"
      className="mx-4 my-3 flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card"
    >
      <h3 className="text-sm font-medium text-foreground-strong">{t('grade.card.title')}</h3>
      {query.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('grade.card.loading')}</span>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('grade.card.unavailable')}</span>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('grade.card.retry')}
          </Button>
        </div>
      ) : query.data.grade === null ? (
        <p className="text-sm text-muted-foreground">{t('grade.card.none')}</p>
      ) : (
        <AiGradeBody grade={query.data.grade} />
      )}
    </section>
  );
}
