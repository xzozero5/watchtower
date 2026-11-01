'use client';

import type { AiEvidence, AiReport } from '@watchtower/shared';
import { TintChip } from '@watchtower/ui';
import { CircleAlert, CircleCheck, CircleHelp, ShieldX } from 'lucide-react';

import { useI18n } from '@/i18n/provider';

import { ConfidenceMeter } from './confidence-meter';

const TOOL_ICONS = { ok: CircleCheck, error: CircleAlert, denied: ShieldX } as const;

/**
 * The investigation report (T-108b) as a fold-out under the brief: the likely cause with its
 * confidence, each finding with the evidence it rests on (a finding with none says so: N5), what is
 * still unknown, and which tools ran. A tool that failed or was refused is listed too, so a gap in
 * the picture is visible. Everything shown is what the api sent.
 */
export function AiReportDetails({
  report,
  evidence,
}: {
  report: AiReport;
  evidence: readonly AiEvidence[];
}) {
  const { t } = useI18n();
  const titleOf = (id: string) => evidence.find((entry) => entry.id === id)?.title ?? id;

  return (
    <details className="group rounded-md" data-testid="ai-report">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm text-xs font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <CircleHelp aria-hidden className="size-3.5" />
        {t('ai.report.title')}
      </summary>
      <div className="mt-2 flex max-w-[72ch] flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-medium text-muted-foreground">{t('ai.report.cause')}</span>
          <ConfidenceMeter value={report.confidence} />
        </div>
        <p className="-mt-2 text-foreground">{report.likelyCause ?? t('ai.report.noCause')}</p>

        {report.findings.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1.5 pl-5">
            {report.findings.map((finding, index) => (
              <li key={index} className="text-foreground">
                {finding.text}{' '}
                {finding.evidenceIds.length > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('ai.report.evidence', {
                      titles: finding.evidenceIds.map(titleOf).join(', '),
                    })}
                  </span>
                ) : (
                  <TintChip tone="amber">{t('ai.report.uncited')}</TintChip>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {report.openQuestions.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('ai.report.unknowns')}</p>
            <ul className="mt-1 list-disc pl-5 text-foreground">
              {report.openQuestions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {report.tools.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('ai.report.tools')}</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {report.tools.map((tool, index) => {
                const Icon = TOOL_ICONS[tool.status];
                return (
                  <li key={`${tool.name}-${String(index)}`}>
                    <TintChip tone={tool.status === 'ok' ? 'teal' : 'amber'} icon={Icon}>
                      {[
                        tool.name,
                        t(`ai.report.toolStatus.${tool.status}`),
                        tool.mock ? t('ai.report.sample') : null,
                      ]
                        .filter((part) => part !== null)
                        .join(' · ')}
                    </TintChip>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {report.scope ? (
          <p className="text-xs text-muted-foreground">
            {t(`ai.report.scope.${report.scope.basis}`)}
          </p>
        ) : null}
      </div>
    </details>
  );
}
