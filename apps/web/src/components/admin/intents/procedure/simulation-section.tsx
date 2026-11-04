'use client';

import type { ProcedureSimulationResult, ProcedureVersion } from '@watchtower/shared';
import { Alert, Button, toast } from '@watchtower/ui';
import { CircleCheck, CircleX } from 'lucide-react';
import { useId, useState } from 'react';

import { useI18n } from '@/i18n/provider';
import type { MessageKey } from '@/i18n';
import { describeError } from '@/lib/admin/errors';
import { useProcedureSimulation } from '@/lib/admin/procedure-queries';
import { isApiError } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/format';

/**
 * The simulation of a version before it is published (T-303f, ADR-026 section 6): the button that queues a run, the
 * wait, and the result: passed or not in words, the numbers against the version live now, and why it did not pass.
 * `canRun` is `procedure.publish`: a person who cannot publish does not run the (costly) simulation.
 */
export function SimulationSection({
  intentId,
  version,
  canRun,
}: {
  intentId: string;
  version: ProcedureVersion;
  canRun: boolean;
}) {
  const { t, locale } = useI18n();
  const base = useId();
  const { result, resultError, running, slow, start } = useProcedureSimulation(intentId, version);
  const [error, setError] = useState<string | null>(null);
  const runnable = version.status === 'confirmed' || version.status === 'simulated';
  const summary = result ?? version.simulation;

  const run = () => {
    setError(null);
    start.mutate(undefined, {
      onSuccess: () => {
        toast(t('procedure.simulation.running'));
      },
      onError: (failure) => {
        if (isApiError(failure) && failure.status === 503)
          setError(t('procedure.simulation.aiOff'));
        else if (isApiError(failure) && failure.status === 409) {
          setError(t('procedure.simulation.conflict'));
        } else setError(describeError(failure, t).message);
      },
    });
  };

  return (
    <section aria-labelledby={`${base}-sim`} className="flex flex-col gap-2">
      <h4 id={`${base}-sim`} className="text-base font-medium text-foreground-strong">
        {t('procedure.simulation.title')}
      </h4>

      {summary ? (
        <div className="flex flex-col gap-1 text-sm">
          <p
            className={`flex items-center gap-1.5 ${summary.passed ? 'text-success' : 'font-medium text-danger'}`}
          >
            {summary.passed ? (
              <CircleCheck aria-hidden className="size-4 shrink-0" />
            ) : (
              <CircleX aria-hidden className="size-4 shrink-0" />
            )}
            {t(summary.passed ? 'procedure.simulation.passed' : 'procedure.simulation.failed', {
              count: summary.caseCount,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('procedure.simulation.at', { date: formatDateTime(summary.createdAt, locale) })}
          </p>
          {summary.seedOnly ? (
            <p className="text-xs text-muted-foreground">{t('procedure.simulation.seedOnly')}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('procedure.simulation.none')}</p>
      )}

      {result ? <Metrics result={result} /> : null}
      {version.simulation !== null && !result && resultError && !running ? (
        <p className="text-xs text-muted-foreground">{t('procedure.simulation.readFailed')}</p>
      ) : null}

      {runnable && canRun ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={running || start.isPending} onClick={run}>
            {t('procedure.simulation.run')}
          </Button>
          {running ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('procedure.simulation.running')}
            </p>
          ) : null}
        </div>
      ) : null}
      {runnable && !canRun ? (
        <p className="text-xs text-muted-foreground">{t('procedure.simulation.needPublish')}</p>
      ) : null}
      {slow ? <Alert tone="info" title={t('procedure.simulation.slow')} /> : null}
      {error ? <Alert tone="error" title={error} /> : null}
    </section>
  );
}

function Metrics({ result }: { result: ProcedureSimulationResult }) {
  const { t } = useI18n();
  const m = result.metrics;
  const live = m.baseline;
  const rows: { label: MessageKey; value: string }[] = [
    { label: 'procedure.simulation.stat.cases', value: String(m.caseCount) },
    ...(m.failedCases > 0
      ? [{ label: 'procedure.simulation.stat.failedCases' as const, value: String(m.failedCases) }]
      : []),
    ...(m.seededCases > 0
      ? [{ label: 'procedure.simulation.stat.seededCases' as const, value: String(m.seededCases) }]
      : []),
    {
      label: 'procedure.simulation.stat.editDistance',
      value:
        `${t('procedure.simulation.stat.thisVersion')} ${m.candidate.editDistance.toFixed(1)}` +
        (live === null
          ? ` · ${t('procedure.simulation.stat.defaultRunbook')}: -`
          : ` · ${t('procedure.simulation.stat.liveVersion')} ${live.editDistance.toFixed(1)}`),
    },
    {
      label: 'procedure.simulation.stat.uncited',
      value:
        String(m.candidate.uncitedClaims) +
        (live === null
          ? ''
          : ` / ${t('procedure.simulation.stat.liveVersion')} ${String(live.uncitedClaims)}`),
    },
    { label: 'procedure.simulation.stat.violations', value: String(m.candidate.violations) },
    { label: 'procedure.simulation.stat.leaks', value: String(m.candidate.disclosureLeaks) },
    { label: 'procedure.simulation.stat.toolCalls', value: String(m.toolCalls) },
    ...(m.deadSteps.length > 0
      ? [{ label: 'procedure.simulation.stat.deadSteps' as const, value: m.deadSteps.join(', ') }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      {m.mode === 'fixture' ? (
        <p className="text-xs text-muted-foreground">{t('procedure.simulation.fixture')}</p>
      ) : null}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{t(row.label)}</dt>
            <dd className="font-medium text-foreground tabular-nums sm:text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {m.failReasons.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-danger">
          {m.failReasons.map((reason) => (
            <li key={reason}>{t(`procedure.simulation.reason.${reason}`)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
