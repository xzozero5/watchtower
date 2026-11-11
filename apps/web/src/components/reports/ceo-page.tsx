'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import type { CeoExternalTile, CeoKpiKey, CeoTile, CeoView } from '@watchtower/shared';
import {
  Button,
  cn,
  IconButton,
  SectionHeading,
  Skeleton,
  StatTile,
  Textarea,
} from '@watchtower/ui';
import {
  CalendarClock,
  CircleCheck,
  Download,
  Gauge,
  Hourglass,
  Layers,
  Smile,
  Sparkles,
  Timer,
  Trash2,
  Upload,
  Bot,
} from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { AccessDenied, LoadError, PageHeader } from '@/components/admin/admin-page';
import { Figure, SectionNote, TileGrid } from '@/components/dashboard/figure';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import { describeError } from '@/lib/admin/errors';
import { useApi } from '@/lib/api/api-context';
import { useSession } from '@/lib/auth/session';
import {
  formatCount,
  formatRate,
  formatScore,
  formatSeconds,
  formatUsd,
} from '@/lib/dashboard/format';
import { formatDateTime } from '@/lib/format';
import { useCeoView, useDeleteCeoMetric, useImportCeoCsv } from '@/lib/reports/queries';
import { type Better, changeOf } from '@/lib/reports/trend';

import { ChangeChip, type ReportWindow, saveBlob, WindowControl } from './report-bits';
import { WeeklyBriefCard } from './weekly-brief-card';

function CeoSkeleton() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">{t('reports.ceo.loading')}</span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-[5.5rem] rounded-card" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-card" />
    </div>
  );
}

/**
 * The CEO view (PRD section 9.2, T-305b): eight figures, each next to the period before it, the
 * automation-savings formula printed in full (it is an assumption), and tiles for numbers the system
 * does not compute. Lead and head. A figure with nothing behind it says why, never a zero (N5).
 */
export function CeoPage() {
  const { can } = useSession();
  if (!can('ceo.view')) return <AccessDenied role="lead" />;
  return <CeoBody />;
}

function CeoBody() {
  const { t } = useI18n();
  const api = useApi();
  const [days, setDays] = useState<ReportWindow>(7);
  const [exportFailed, setExportFailed] = useState(false);
  const query = useCeoView(days, true);
  const view = query.data;
  const refreshing = query.isPlaceholderData;

  const exportAs = async (format: 'csv' | 'html') => {
    setExportFailed(false);
    try {
      const bytes = await api.ceoExport({ days, format });
      saveBlob(
        bytes,
        `ceo-view-${new Date().toISOString().slice(0, 10)}.${format}`,
        format === 'csv' ? 'text/csv' : 'text/html',
      );
    } catch {
      setExportFailed(true);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('reports.ceo.title')}
        actions={
          <>
            {view ? (
              <span className="text-xs text-muted-foreground">
                <span className="sr-only">{t('reports.updated')} </span>
                <RelativeTime iso={view.generatedAt} />
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={!view}
              onClick={() => {
                void exportAs('csv');
              }}
            >
              <Download aria-hidden className="size-4" />
              {t('reports.ceo.export.label')} {t('reports.ceo.export.csv')}
            </Button>
            <Button
              size="sm"
              disabled={!view}
              onClick={() => {
                void exportAs('html');
              }}
            >
              <Download aria-hidden className="size-4" />
              {t('reports.ceo.export.label')} {t('reports.ceo.export.html')}
            </Button>
          </>
        }
      />
      <main
        id="main-content"
        aria-busy={query.isPending || undefined}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 lg:p-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <WindowControl days={days} onChange={setDays} />
            <p className="text-sm text-muted-foreground">{t('reports.ceo.lead')}</p>
          </div>
          {exportFailed ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {t('reports.ceo.export.failed')}
            </p>
          ) : null}
          {query.isError && !view ? (
            <LoadError
              message={t('reports.ceo.loadError')}
              onRetry={() => void query.refetch()}
              className="px-0"
            />
          ) : !view ? (
            <CeoSkeleton />
          ) : (
            <div
              aria-busy={refreshing || undefined}
              className={cn(
                'flex flex-col gap-6 motion-safe:transition-opacity',
                refreshing && 'opacity-60',
              )}
            >
              {query.isError ? (
                <LoadError
                  message={t('reports.ceo.loadError')}
                  onRetry={() => void query.refetch()}
                  className="px-0 py-0"
                />
              ) : null}
              {view.seedExcluded ? (
                <p className="text-sm text-muted-foreground">{t('reports.ceo.seedExcluded')}</p>
              ) : null}
              <WeeklyBriefCard />
              <KpiTiles view={view} />
              <FormulaSection view={view} />
              <ExternalTiles view={view} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// --- the eight figures ------------------------------------------------------------------------------

function currentIsoWeek(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `w${String(d.getUTCFullYear())}-${String(weekNo).padStart(2, '0')}`;
}

function KpiTiles({ view }: { view: CeoView }) {
  const { t, locale } = useI18n();
  const { kpis, formula } = view;
  const info = (key: CeoKpiKey) => ({
    info: t(`reports.ceo.info.${key}`),
    infoLabel: t('reports.ceo.info.label', { name: t(`reports.ceo.kpi.${key}`) }),
  });
  const chip = (data: CeoTile, kind: 'relative' | 'share', better: Better) => (
    <ChangeChip change={changeOf(data.value, data.previous, kind, better)} />
  );
  const stack = (data: CeoTile, kind: 'relative' | 'share', better: Better, text?: ReactNode) => (
    <span className="flex flex-col items-start gap-1">
      {chip(data, kind, better)}
      {text ? <span>{text}</span> : null}
    </span>
  );
  const samples = (data: CeoTile) =>
    t('reports.ceo.detail.samples', { count: formatCount(data.samples, locale) });
  return (
    <section aria-labelledby="ceo-kpis" className="flex flex-col gap-3">
      <h2 id="ceo-kpis" className="sr-only">
        {t('reports.ceo.title')}
      </h2>
      <ElementInsight
        element="reports.ceo.figures"
        period={currentIsoWeek()}
        followUp={<AskAiElement element="reports.ceo.figures" presentation="follow-up" />}
      />
      <TileGrid>
        <Figure
          label={t('reports.ceo.kpi.volume')}
          icon={Layers}
          tone="blue"
          value={kpis.volume}
          show={(d) => formatCount(d.value, locale)}
          detail={(d) => stack(d, 'relative', 'neutral')}
          {...info('volume')}
        />
        <Figure
          label={t('reports.ceo.kpi.firstResponse')}
          icon={Timer}
          tone="amber"
          value={kpis.firstResponse}
          show={(d) => formatSeconds(d.value, locale)}
          detail={(d) => stack(d, 'relative', 'lower', samples(d))}
          {...info('firstResponse')}
        />
        <Figure
          label={t('reports.ceo.kpi.resolution')}
          icon={Hourglass}
          tone="amber"
          value={kpis.resolution}
          show={(d) => formatSeconds(d.value, locale)}
          detail={(d) => stack(d, 'relative', 'lower', samples(d))}
          {...info('resolution')}
        />
        <Figure
          label={t('reports.ceo.kpi.sla')}
          icon={Gauge}
          tone="teal"
          value={kpis.sla}
          show={(d) => formatRate(d.value, locale)}
          detail={(d) => stack(d, 'share', 'higher', samples(d))}
          {...info('sla')}
        />
        <Figure
          label={t('reports.ceo.kpi.csat')}
          icon={Smile}
          tone="teal"
          value={kpis.csat}
          show={(d) => formatScore(d.value, locale)}
          detail={(d) =>
            stack(
              d,
              'relative',
              'higher',
              t('reports.ceo.detail.surveys', { count: formatCount(d.samples, locale) }),
            )
          }
          {...info('csat')}
        />
        <Figure
          label={t('reports.ceo.kpi.aiHandled')}
          icon={Bot}
          tone="sky"
          value={kpis.aiHandled}
          show={(d) => formatRate(d.value, locale)}
          detail={(d) =>
            stack(
              d,
              'share',
              'higher',
              t('reports.ceo.detail.assisted', {
                count: formatCount(formula.aiHandledTickets, locale),
                noTouch: formatCount(formula.noTouchTickets, locale),
              }),
            )
          }
          {...info('aiHandled')}
        />
        <Figure
          label={t('reports.ceo.kpi.verifiedResolution')}
          icon={CircleCheck}
          tone="sky"
          value={kpis.verifiedResolution}
          show={(d) => formatRate(d.value, locale)}
          detail={(d) =>
            stack(
              d,
              'share',
              'higher',
              t('reports.ceo.detail.graded', { count: formatCount(d.samples, locale) }),
            )
          }
          {...info('verifiedResolution')}
        />
        <Figure
          label={t('reports.ceo.kpi.automationSavings')}
          icon={Sparkles}
          tone="violet"
          value={kpis.automationSavings}
          show={(d) => t('reports.ceo.unit.hours', { value: hours(d.value, locale) })}
          detail={(d) => stack(d, 'relative', 'higher', t('dashboard.assumed'))}
          {...info('automationSavings')}
        />
      </TileGrid>
    </section>
  );
}

const hours = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

// --- the formula, printed (it is an assumption) --------------------------------------------------------

function FormulaSection({ view }: { view: CeoView }) {
  const { t, locale } = useI18n();
  const { formula } = view;
  const usd = (value: number | null) =>
    value === null ? t('reports.ceo.formula.unknown') : formatUsd(value, locale);
  return (
    <section aria-labelledby="ceo-formula" className="flex flex-col gap-2">
      <h2 id="ceo-formula" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="violet" icon={Sparkles} plain>
          {t('reports.ceo.formula.title')}
        </SectionHeading>
      </h2>
      <div className="flex max-w-3xl flex-col gap-1.5 rounded-card bg-surface px-5 py-4 text-sm shadow-card">
        <p className="font-medium">{t('reports.ceo.formula.assumed')}</p>
        <p className="tabular">
          {t('reports.ceo.formula.line', {
            tickets: formatCount(formula.aiHandledTickets, locale),
            minutes: formatCount(formula.minutesPerTicket, locale),
            hours: hours(formula.hours, locale),
          })}
        </p>
        {formula.staffCostUsdPerHour === null ? (
          <p>{t('reports.ceo.formula.noCost')}</p>
        ) : (
          <>
            <p className="tabular">
              {t('reports.ceo.formula.cost', {
                rate: formatUsd(formula.staffCostUsdPerHour, locale),
                saved: usd(formula.savedUsd),
              })}
            </p>
            <p className="tabular">
              {t('reports.ceo.formula.aiCost', {
                spent: formatUsd(formula.aiCostUsd, locale),
                net: usd(formula.netUsd),
              })}
            </p>
          </>
        )}
        <p className="tabular">
          {t('reports.ceo.formula.perTicket', {
            current:
              formula.aiCostPerResolvedTicketUsd === null
                ? t('reports.ceo.formula.none')
                : formatUsd(formula.aiCostPerResolvedTicketUsd, locale),
            previous:
              formula.previousAiCostPerResolvedTicketUsd === null
                ? t('reports.ceo.formula.none')
                : formatUsd(formula.previousAiCostPerResolvedTicketUsd, locale),
          })}
        </p>
        <p className="text-muted-foreground">{t('reports.ceo.formula.settings')}</p>
      </div>
    </section>
  );
}

// --- tiles fed from outside -----------------------------------------------------------------------------

function ExternalTiles({ view }: { view: CeoView }) {
  const { t } = useI18n();
  const { can } = useSession();
  return (
    <section aria-labelledby="ceo-external" className="flex flex-col gap-3">
      <h2 id="ceo-external" className="text-title font-medium text-foreground-strong">
        <SectionHeading tone="slate" icon={CalendarClock} plain>
          {t('reports.ceo.external.title')}
        </SectionHeading>
      </h2>
      <p className="text-sm text-muted-foreground">{t('reports.ceo.external.lead')}</p>
      {view.externalTiles.length === 0 ? (
        <SectionNote figure={{ status: 'not_available', reason: 'not_collected' }} />
      ) : (
        <TileGrid>
          {view.externalTiles.map((tile) => (
            <ExternalTile key={tile.key} tile={tile} />
          ))}
        </TileGrid>
      )}
      {can('metric.manage') ? <ImportPanel /> : null}
    </section>
  );
}

function ExternalTile({ tile }: { tile: CeoExternalTile }) {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const remove = useDeleteCeoMetric();
  const [asking, setAsking] = useState(false);
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(tile.value);
  return (
    <div className="relative">
      <StatTile
        label={tile.label}
        icon={CalendarClock}
        tone="slate"
        value={tile.unit === '' ? number : `${number} ${tile.unit}`}
        detail={
          <span className="flex flex-col items-start gap-1">
            <ChangeChip
              change={changeOf(
                tile.value,
                tile.previous,
                'relative',
                tile.higherIsBetter ? 'higher' : 'lower',
              )}
            />
            <span>
              {t('reports.ceo.external.observed', {
                date: formatDateTime(tile.observedAt, locale),
              })}
            </span>
          </span>
        }
      />
      {can('metric.manage') ? (
        <>
          <IconButton
            variant="ghost"
            label={t('reports.ceo.external.remove', { name: tile.label })}
            icon={<Trash2 aria-hidden className="size-4" />}
            className="absolute top-1.5 right-1.5"
            onClick={() => {
              setAsking(true);
            }}
          />
          <ConfirmDialog
            open={asking}
            onOpenChange={(open) => {
              setAsking(open);
              if (!open) remove.reset();
            }}
            title={t('reports.ceo.external.removeTitle', { name: tile.label })}
            description={t('reports.ceo.external.removeBody')}
            confirmLabel={t('reports.ceo.external.removeConfirm')}
            pending={remove.isPending}
            error={remove.isError ? describeError(remove.error, t).message : null}
            onConfirm={() => {
              remove.mutate(tile.key, {
                onSuccess: () => {
                  setAsking(false);
                },
              });
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function ImportPanel() {
  const { t } = useI18n();
  const importCsv = useImportCeoCsv();
  const [csv, setCsv] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const field = useId();
  const file = useRef<HTMLInputElement>(null);

  const readFile = async (selected: File | undefined) => {
    if (!selected) return;
    setCsv(await selected.text());
    setDone(null);
    importCsv.reset();
  };

  return (
    <div className="flex max-w-3xl flex-col gap-2 rounded-card bg-surface px-5 py-4 shadow-card">
      <h3 className="text-sm font-medium text-foreground-strong">
        {t('reports.ceo.external.manage.title')}
      </h3>
      <label htmlFor={field} className="text-sm font-medium">
        {t('reports.ceo.external.manage.csvLabel')}
      </label>
      <Textarea
        id={field}
        rows={5}
        value={csv}
        spellCheck={false}
        aria-describedby={`${field}-hint`}
        className="font-mono text-xs"
        onChange={(event) => {
          setCsv(event.target.value);
          setDone(null);
        }}
      />
      <p id={`${field}-hint`} className="text-xs text-muted-foreground">
        {t('reports.ceo.external.manage.csvHint')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          tabIndex={-1}
          aria-label={t('reports.ceo.external.manage.fileLabel')}
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <Button
          size="sm"
          onClick={() => {
            file.current?.click();
          }}
        >
          <Upload aria-hidden className="size-4" />
          {t('reports.ceo.external.manage.fileLabel')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={csv.trim() === '' || importCsv.isPending}
          onClick={() => {
            importCsv.mutate(csv, {
              onSuccess: (result) => {
                setDone(result.imported);
                setCsv('');
              },
            });
          }}
        >
          {importCsv.isPending
            ? t('reports.ceo.external.manage.importing')
            : t('reports.ceo.external.manage.import')}
        </Button>
      </div>
      {importCsv.isError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {t('reports.ceo.external.manage.failed', {
            message: describeError(importCsv.error, t).message,
          })}
        </p>
      ) : null}
      {done !== null ? (
        <p role="status" className="text-sm font-medium">
          {t('reports.ceo.external.manage.done', { count: done })}
        </p>
      ) : null}
    </div>
  );
}
