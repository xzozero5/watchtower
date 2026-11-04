'use client';

import type { GateCriterion, GateReport } from '@watchtower/shared';
import { Button, TintChip } from '@watchtower/ui';
import { CircleCheck, CircleHelp, CircleX, FileBarChart } from 'lucide-react';

import { useI18n } from '@/i18n/provider';
import type { Translate } from '@/i18n';
import { CRITERION_KEYS, criterionState, shadowMetrics } from '@/lib/admin/stage3';
import { formatDateTime } from '@/lib/format';

const RATE_KEYS: ReadonlySet<string> = new Set([
  'verified_resolution',
  'reopen_rate',
  'shadow_precision',
]);

/** A value or a limit as text. Rates are shown as percentages; text such as `not_measured` as words. */
function cell(key: string, value: GateCriterion['value'], t: Translate, locale: string): string {
  if (value === null) return t('stage3.report.noValue');
  if (value === 'not_measured') return t('stage3.report.notMeasured');
  if (typeof value === 'number') {
    if (RATE_KEYS.has(key)) {
      return `${(value * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
    }
    return value.toLocaleString(locale, { maximumFractionDigits: 2 });
  }
  return String(value);
}

/**
 * The gate report of an intent (ADR-025 section 6): every check with its result in words and an icon (never
 * colour alone), its value, its limit and where the limit comes from (`PRD` written in the requirements, or
 * `ASSUMED`, a default not yet confirmed). A check that cannot be measured yet says "not known yet".
 */
export function GateReportCard({
  report,
  canMake,
  making,
  makeError,
  onMake,
}: {
  report: GateReport | null;
  canMake: boolean;
  making: boolean;
  makeError: string | null;
  onMake: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <section aria-labelledby="stage3-report" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="stage3-report" className="text-base font-semibold">
            {t('stage3.report.title')}
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">{t('stage3.report.lead')}</p>
        </div>
        {canMake ? (
          <Button onClick={onMake} disabled={making}>
            <FileBarChart aria-hidden className="size-4" />
            {making ? t('stage3.report.generating') : t('stage3.report.generate')}
          </Button>
        ) : null}
      </div>
      {makeError ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger">
          <CircleX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{makeError}</span>
        </p>
      ) : null}
      {!report ? (
        <p className="text-sm text-muted-foreground">{t('stage3.report.none')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <TintChip
              tone={report.status === 'green' ? 'green' : report.status === 'red' ? 'red' : 'amber'}
              icon={
                report.status === 'green'
                  ? CircleCheck
                  : report.status === 'red'
                    ? CircleX
                    : CircleHelp
              }
              strong
            >
              {t(`stage3.report.status.${report.status}`)}
            </TintChip>
            <span className="text-sm text-muted-foreground">
              {t(`stage3.report.trigger.${report.triggerKind}`)} ·{' '}
              {t('stage3.report.madeAt', { time: formatDateTime(report.generatedAt, locale) })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('stage3.report.window', {
              from: formatDateTime(report.windowStart, locale),
              to: formatDateTime(report.windowEnd, locale),
            })}
            {report.seedExcluded ? ` · ${t('stage3.report.seedExcluded')}` : ''}
          </p>
          <div className="overflow-x-auto">
            <table aria-label={t('stage3.report.table')} className="w-full max-w-3xl text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('stage3.report.col.check')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('stage3.report.col.result')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('stage3.report.col.value')}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t('stage3.report.col.limit')}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    {t('stage3.report.col.basis')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.criteria.map((criterion) => {
                  const state = criterionState(criterion);
                  const nameKey = CRITERION_KEYS[criterion.key];
                  const Icon =
                    state === 'pass' ? CircleCheck : state === 'fail' ? CircleX : CircleHelp;
                  return (
                    <tr key={criterion.key} data-criterion={criterion.key} data-state={state}>
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {nameKey ? t(nameKey) : criterion.key}
                      </th>
                      <td className="py-1.5 pr-3">
                        <span className="inline-flex items-center gap-1 font-medium">
                          <Icon aria-hidden className="size-4 shrink-0" />
                          {t(`stage3.report.result.${state}`)}
                        </span>
                      </td>
                      <td className="tabular py-1.5 pr-3">
                        {cell(criterion.key, criterion.value, t, locale)}
                      </td>
                      <td className="tabular py-1.5 pr-3">
                        {cell(criterion.key, criterion.threshold, t, locale)}
                      </td>
                      <td className="py-1.5">
                        {criterion.basis ? (
                          <span
                            title={t(`stage3.report.basisHint.${criterion.basis}`)}
                            className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs"
                          >
                            {t(`stage3.report.basis.${criterion.basis}`)}
                            <span className="sr-only">
                              {' '}
                              — {t(`stage3.report.basisHint.${criterion.basis}`)}
                            </span>
                          </span>
                        ) : (
                          t('stage3.report.noValue')
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Shadow results from the latest report: how many drafts were graded, how many a person accepted. */
export function ShadowCard({ report }: { report: GateReport | null }) {
  const { t, locale } = useI18n();
  const shadow = shadowMetrics(report);
  const number = (value: number) => value.toLocaleString(locale);
  return (
    <section aria-labelledby="stage3-shadow" className="flex flex-col gap-2">
      <h2 id="stage3-shadow" className="text-base font-semibold">
        {t('stage3.shadow.title')}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{t('stage3.shadow.lead')}</p>
      {!shadow || shadow.evaluations === 0 ? (
        <p className="text-sm text-muted-foreground">{t('stage3.shadow.none')}</p>
      ) : (
        <dl className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('stage3.shadow.evaluations')}</dt>
          <dd className="tabular font-medium">{number(shadow.evaluations)}</dd>
          <dt className="text-muted-foreground">{t('stage3.shadow.decided')}</dt>
          <dd className="tabular font-medium">{number(shadow.decided)}</dd>
          <dt className="text-muted-foreground">{t('stage3.shadow.accepted')}</dt>
          <dd className="tabular font-medium">{number(shadow.accepted)}</dd>
          <dt className="text-muted-foreground">{t('stage3.shadow.precision')}</dt>
          <dd className="tabular font-medium">
            {shadow.precision === null
              ? t('stage3.report.noValue')
              : `${(shadow.precision * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%`}
          </dd>
        </dl>
      )}
    </section>
  );
}
