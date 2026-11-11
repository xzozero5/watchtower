'use client';

import { AskAiElement } from '@/components/assistant/ask-ai-element';
import { ElementInsight } from '@/components/insights/element-insight';

import {
  DASHBOARD_AT_RISK_MINUTES,
  DASHBOARD_CFR_ATTRIBUTION_HOURS,
  DASHBOARD_KB_STALE_DAYS,
  DASHBOARD_SEVERITIES,
  type DashboardDuration,
  type DashboardOps,
  type IncidentSeverity,
  type IncidentStatus,
  INCIDENT_STATUSES,
} from '@watchtower/shared';
import {
  Avatar,
  BarChart,
  type BarChartDatum,
  BarList,
  type BarListDatum,
  StageBadge,
  TintChip,
  type ChipIcon,
  type TintId,
} from '@watchtower/ui';
import {
  Activity,
  Bot,
  CircleCheck,
  CircleDollarSign,
  CirclePause,
  Clock3,
  Flame,
  Gauge,
  Inbox,
  Layers,
  Lock,
  MessageSquare,
  OctagonAlert,
  Radio,
  RefreshCcw,
  Smile,
  Timer,
  TriangleAlert,
  UserRoundX,
  Users,
  Wrench,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { AppLink } from '@/components/app-link';
import { IncidentSeverityBadge, IncidentStatusChip } from '@/components/ops/ops-bits';
import { RelativeTime } from '@/components/relative-time';
import { useI18n } from '@/i18n/provider';
import type { Messages } from '@/i18n/messages/en';
import { STAGE_LABEL_KEYS, asStage } from '@/lib/admin/stages';
import {
  formatCount,
  formatDay,
  formatRate,
  formatScore,
  formatSeconds,
  formatUsd,
} from '@/lib/dashboard/format';
import { INCIDENT_SEVERITY_LABELS } from '@/lib/ops/model';

import { DashboardSection, Figure, SectionNote, TileGrid } from './figure';

interface SectionProps {
  ops: DashboardOps;
}

const AGE_BUCKETS = ['lt_4h', 'h4_24', 'd1_3', 'gt_3d'] as const;

/** Prose in a `?` popover: the definition, and the `[ASSUMED]` rule when there is one. */
const Info = ({ children }: { children: ReactNode }) => <p>{children}</p>;

const CHANNELS = [
  'gmail',
  'line',
  'portal',
  'discord',
  'webhook',
  'internal',
  'phone',
  'walk_in',
  'chat',
  'other',
] as const satisfies readonly (keyof Messages['channel'])[];
const isChannel = (key: string): key is (typeof CHANNELS)[number] =>
  (CHANNELS as readonly string[]).includes(key);
const isSeverity = (value: string): value is IncidentSeverity =>
  (DASHBOARD_SEVERITIES as readonly string[]).includes(value);
const isIncidentStatus = (value: string): value is IncidentStatus =>
  (INCIDENT_STATUSES as readonly string[]).includes(value);

/** The tint of an incident severity, as in the severity badge (SEV1 red, SEV2 amber, SEV3 sky, SEV4 slate). */
const SEVERITY_TINT: Record<IncidentSeverity, TintId> = {
  SEV1: 'red',
  SEV2: 'amber',
  SEV3: 'sky',
  SEV4: 'slate',
};

/** "median, p90 1h 30m" and the sample size on two lines: a median of one ticket must read as one. */
function Spread({ d }: { d: DashboardDuration }) {
  const { t, locale } = useI18n();
  return (
    <>
      <span className="block">
        {t('dashboard.sla.p90', { value: formatSeconds(d.p90Seconds, locale) })}
      </span>
      <span className="block">
        {t('dashboard.sla.samples', { count: formatCount(d.samples, locale) })}
      </span>
    </>
  );
}

// --- Now -----------------------------------------------------------------------------------------

export function NowSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { queue } = ops;
  const minutes = queue.atRiskMinutes || DASHBOARD_AT_RISK_MINUTES;
  const aging: BarListDatum[] = AGE_BUCKETS.map((bucket, index) => ({
    key: bucket,
    label: t(`dashboard.now.age.${bucket}`),
    name: t(`dashboard.now.age.${bucket}`),
    value: queue.aging[bucket],
    color: `var(--wt-color-chart-ordinal-${String(index + 1)})`,
  }));
  const tile = (label: string, icon: ChipIcon, tone: TintId, value: number) => ({
    label,
    icon,
    tone,
    value: { status: 'ok' as const, data: value },
    show: (n: number) => formatCount(n, locale),
  });
  return (
    <DashboardSection id="now" icon={Inbox} tone="teal" title={t('dashboard.sections.now')}>
      <ElementInsight
        element="dashboard.ops.now"
        period="now"
        followUp={<AskAiElement presentation="follow-up" element="dashboard.ops.now" />}
      />
      <TileGrid>
        <Figure {...tile(t('dashboard.now.open'), Inbox, 'teal', queue.open)} />
        <Figure {...tile(t('dashboard.now.unassigned'), UserRoundX, 'sky', queue.unassigned)} />
        <Figure
          {...tile(t('dashboard.now.breached'), OctagonAlert, 'red', queue.breachedNow)}
          alert={(n) => n > 0}
        />
        <Figure
          {...tile(t('dashboard.now.atRisk'), TriangleAlert, 'amber', queue.atRiskNow)}
          infoLabel={t('dashboard.now.atRiskAbout')}
          info={
            <Info>
              {t('dashboard.now.atRiskInfo', { minutes, assumed: t('dashboard.assumed') })}
            </Info>
          }
        />
        <Figure
          {...tile(t('dashboard.now.paused'), CirclePause, 'slate', queue.paused)}
          infoLabel={t('dashboard.now.pausedAbout')}
          info={<Info>{t('dashboard.now.pausedInfo')}</Info>}
        />
      </TileGrid>
      <BarList
        data={aging}
        title={t('dashboard.now.agingTitle')}
        valueLabel={t('dashboard.now.ageValue')}
        categoryLabel={t('dashboard.now.ageColumn')}
        labels={{
          showTable: t('dashboard.volume.chart.showTable'),
          showChart: t('dashboard.volume.chart.showChart'),
        }}
        formatValue={(n) => formatCount(n, locale)}
        className="max-w-xl"
      />
    </DashboardSection>
  );
}

// --- Volume and channel --------------------------------------------------------------------------

export function VolumeSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { volume } = ops;
  const data: BarChartDatum[] = volume.byDay.map((entry) => ({
    key: entry.day,
    label: formatDay(entry.day, locale, 'long'),
    axisLabel: formatDay(entry.day, locale, 'short'),
    value: entry.created,
  }));
  const channels = Object.entries(volume.byChannel).sort(([, a], [, b]) => b - a);
  return (
    <DashboardSection id="volume" icon={Layers} tone="blue" title={t('dashboard.sections.volume')}>
      <ElementInsight
        element="dashboard.ops.volume"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.volume"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <div className="grid gap-3 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-2">
          <Figure
            label={t('dashboard.volume.created')}
            icon={Layers}
            tone="blue"
            value={{ status: 'ok', data: volume.created }}
            show={(n) => formatCount(n, locale)}
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">{t('dashboard.volume.byChannel')}</p>
            {channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard.volume.noChannels')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {channels.map(([channel, count]) => (
                  <li key={channel}>
                    <TintChip tone="slate" icon={MessageSquare}>
                      {isChannel(channel) ? t(`channel.${channel}`) : channel}{' '}
                      <span className="tabular font-semibold">{formatCount(count, locale)}</span>
                    </TintChip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <BarChart
          data={data}
          title={t('dashboard.volume.perDay')}
          valueLabel={t('dashboard.volume.createdValue')}
          categoryLabel={t('dashboard.volume.dayColumn')}
          labels={{
            showTable: t('dashboard.volume.chart.showTable'),
            showChart: t('dashboard.volume.chart.showChart'),
          }}
          emptyText={t('dashboard.volume.chart.empty')}
          keyboardHint={t('dashboard.volume.chart.keys')}
          formatValue={(n) => formatCount(n, locale)}
        />
      </div>
    </DashboardSection>
  );
}

// --- SLA -----------------------------------------------------------------------------------------

export function SlaSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { sla } = ops;
  // The basis is a fact of the read model (`wall_clock`), shown on every duration and rate.
  const info = (
    <Info>
      {t('dashboard.sla.wallClock')} {t('dashboard.assumed')}
    </Info>
  );
  const infoLabel = t('dashboard.sla.basisAbout');
  return (
    <DashboardSection id="sla" icon={Clock3} tone="amber" title={t('dashboard.sections.sla')}>
      <ElementInsight
        element="dashboard.ops.sla"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.sla"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.sla.firstResponse')}
          icon={Timer}
          tone="amber"
          value={sla.firstResponse}
          show={(d) => formatSeconds(d.medianSeconds, locale)}
          detail={(d) => <Spread d={d} />}
          info={info}
          infoLabel={infoLabel}
        />
        <Figure
          label={t('dashboard.sla.resolution')}
          icon={Timer}
          tone="amber"
          value={sla.resolution}
          show={(d) => formatSeconds(d.medianSeconds, locale)}
          detail={(d) => <Spread d={d} />}
          info={info}
          infoLabel={infoLabel}
        />
        <Figure
          label={t('dashboard.sla.firstResponseBreach')}
          icon={OctagonAlert}
          tone="red"
          value={sla.firstResponseBreach}
          show={(d) => formatRate(d.rate, locale)}
          detail={(d) =>
            t('dashboard.sla.breachedOf', {
              breached: formatCount(d.breached, locale),
              evaluated: formatCount(d.evaluated, locale),
            })
          }
          info={info}
          infoLabel={infoLabel}
        />
        <Figure
          label={t('dashboard.sla.resolutionBreach')}
          icon={OctagonAlert}
          tone="red"
          value={sla.resolutionBreach}
          show={(d) => formatRate(d.rate, locale)}
          detail={(d) =>
            t('dashboard.sla.breachedOf', {
              breached: formatCount(d.breached, locale),
              evaluated: formatCount(d.evaluated, locale),
            })
          }
          info={info}
          infoLabel={infoLabel}
        />
      </TileGrid>
    </DashboardSection>
  );
}

// --- Quality -------------------------------------------------------------------------------------

export function QualitySection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { quality } = ops;
  return (
    <DashboardSection
      id="quality"
      icon={Smile}
      tone="green"
      title={t('dashboard.sections.quality')}
    >
      <ElementInsight
        element="dashboard.ops.quality"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.quality"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.quality.csat')}
          icon={Smile}
          tone="green"
          value={quality.csat}
          show={(d) => `${formatScore(d.average, locale)} / 5`}
          detail={(d) =>
            t('dashboard.quality.csatDetail', {
              answered: formatCount(d.answered, locale),
              sent: formatCount(d.sent, locale),
            })
          }
          info={<Info>{t('dashboard.quality.csatInfo')}</Info>}
          infoLabel={t('dashboard.quality.csatAbout')}
        />
        <Figure
          label={t('dashboard.quality.reopen')}
          icon={RefreshCcw}
          tone="amber"
          value={quality.reopen}
          show={(d) => formatRate(d.rate, locale)}
          detail={(d) =>
            t('dashboard.quality.reopenDetail', {
              reopened: formatCount(d.reopened, locale),
              resolved: formatCount(d.resolved, locale),
            })
          }
        />
        <Figure
          label={t('dashboard.quality.toDev')}
          icon={Wrench}
          tone="indigo"
          value={quality.toDev}
          show={(d) => formatRate(d.rate, locale)}
          detail={(d) =>
            t('dashboard.quality.toDevDetail', {
              waited: formatCount(d.waitedOnDev, locale),
              tickets: formatCount(d.tickets, locale),
            })
          }
        />
        <Figure
          label={t('dashboard.quality.escalation')}
          icon={Zap}
          tone="orange"
          value={quality.escalation}
          show={(d) => formatRate(d.rate, locale)}
        />
      </TileGrid>
    </DashboardSection>
  );
}

// --- Reliability ---------------------------------------------------------------------------------

export function ReliabilitySection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { incidents, alerts, changeFailure } = ops.reliability;
  const ok = (data: number) => ({ status: 'ok' as const, data });
  const count = (n: number) => formatCount(n, locale);
  const severity: BarListDatum[] = DASHBOARD_SEVERITIES.map((level) => ({
    key: level,
    label: <IncidentSeverityBadge severity={level} />,
    name: `${level} ${t(INCIDENT_SEVERITY_LABELS[level])}`,
    value: incidents.bySeverity[level],
    color: `var(--wt-color-tint-${SEVERITY_TINT[level]}-icon)`,
  }));
  const cfrHours =
    changeFailure.status === 'ok'
      ? changeFailure.data.attributionHours
      : DASHBOARD_CFR_ATTRIBUTION_HOURS;
  return (
    <DashboardSection
      id="reliability"
      icon={Flame}
      tone="red"
      title={t('dashboard.sections.reliability')}
    >
      <ElementInsight
        element="dashboard.ops.reliability"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.reliability"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.reliability.openIncidents')}
          icon={Flame}
          tone="amber"
          value={ok(incidents.openNow)}
          show={count}
          alert={(n) => n > 0}
        />
        <Figure
          label={t('dashboard.reliability.started')}
          icon={Flame}
          tone="slate"
          value={ok(incidents.started)}
          show={count}
        />
        <Figure
          label={t('dashboard.reliability.affectedOrgs')}
          icon={Users}
          tone="slate"
          value={ok(incidents.affectedOrgs)}
          show={count}
        />
        <Figure
          label={t('dashboard.reliability.openAlerts')}
          icon={Radio}
          tone="red"
          value={ok(alerts.openNow)}
          show={count}
        />
        <Figure
          label={t('dashboard.reliability.mttr')}
          icon={Timer}
          tone="amber"
          value={incidents.mttr}
          show={(d) => formatSeconds(d.medianSeconds, locale)}
          detail={(d) => <Spread d={d} />}
        />
        <Figure
          label={t('dashboard.reliability.mtta')}
          icon={Timer}
          tone="amber"
          value={alerts.mtta}
          show={(d) => formatSeconds(d.medianSeconds, locale)}
          detail={(d) => <Spread d={d} />}
        />
        <Figure
          label={t('dashboard.reliability.noise')}
          icon={Radio}
          tone="slate"
          value={alerts.noise}
          show={(d) => formatRate(d.ratio, locale)}
          detail={(d) =>
            t('dashboard.reliability.noiseDetail', {
              noisy: count(d.noisy),
              settled: count(d.settled),
            })
          }
          info={<Info>{t('dashboard.reliability.noiseInfo')}</Info>}
          infoLabel={t('dashboard.reliability.noiseAbout')}
        />
        <Figure
          label={t('dashboard.reliability.cfr')}
          icon={Zap}
          tone="orange"
          value={changeFailure}
          show={(d) => formatRate(d.rate, locale)}
          detail={(d) =>
            t('dashboard.reliability.cfrDetail', {
              failed: count(d.followedByIncident),
              deploys: count(d.deploys),
            })
          }
          info={
            <Info>
              {t('dashboard.reliability.cfrInfo', {
                hours: cfrHours,
                assumed: t('dashboard.assumed'),
              })}
            </Info>
          }
          infoLabel={t('dashboard.reliability.cfrAbout')}
        />
      </TileGrid>
      <div className="grid gap-4 lg:grid-cols-2">
        <BarList
          data={severity}
          title={t('dashboard.reliability.severityTitle')}
          valueLabel={t('dashboard.reliability.severityValue')}
          categoryLabel={t('dashboard.reliability.severityColumn')}
          labels={{
            showTable: t('dashboard.volume.chart.showTable'),
            showChart: t('dashboard.volume.chart.showChart'),
          }}
          formatValue={count}
        />
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {t('dashboard.reliability.openList')}
          </h3>
          {incidents.open.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck aria-hidden className="size-4 shrink-0" />
              {t('dashboard.reliability.noOpen')}
            </p>
          ) : (
            <ul className="flex flex-col">
              {incidents.open.map((incident) => (
                <li
                  key={incident.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 py-1.5 last:border-b-0"
                >
                  {isSeverity(incident.severity) ? (
                    <IncidentSeverityBadge severity={incident.severity} />
                  ) : (
                    <span className="text-xs">{incident.severity}</span>
                  )}
                  <AppLink
                    href={`/incidents?incident=${encodeURIComponent(incident.id)}`}
                    className="min-w-40 flex-1 truncate rounded text-sm font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="tabular text-muted-foreground">#{incident.number}</span>{' '}
                    {incident.title}
                  </AppLink>
                  {isIncidentStatus(incident.status) ? (
                    <IncidentStatusChip status={incident.status} />
                  ) : null}
                  <RelativeTime
                    iso={incident.startedAt}
                    className="text-xs text-muted-foreground"
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </DashboardSection>
  );
}

// --- AI ------------------------------------------------------------------------------------------

export function AiSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const count = (n: number) => formatCount(n, locale);
  const { ai } = ops;
  if (ai.status !== 'ok') {
    return (
      <DashboardSection id="ai" icon={Bot} tone="teal" title={t('dashboard.sections.ai')}>
        <ElementInsight
          element="dashboard.ops.ai"
          period={`d${String(ops.window.days)}`}
          followUp={
            <AskAiElement
              presentation="follow-up"
              element="dashboard.ops.ai"
              period={`d${String(ops.window.days)}`}
            />
          }
        />
        <SectionNote figure={ai} />
      </DashboardSection>
    );
  }
  const data = ai.data;
  return (
    <DashboardSection id="ai" icon={Bot} tone="teal" title={t('dashboard.sections.ai')}>
      <ElementInsight
        element="dashboard.ops.ai"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.ai"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.ai.acceptance')}
          icon={CircleCheck}
          tone="teal"
          value={data.drafts}
          show={(d) => formatRate(d.acceptanceRate, locale)}
          detail={(d) =>
            t('dashboard.ai.acceptanceDetail', {
              decided: count(d.decided),
              edited: count(d.edited),
            })
          }
        />
        <Figure
          label={t('dashboard.ai.cost')}
          icon={CircleDollarSign}
          tone="teal"
          value={data.cost}
          show={(d) => formatUsd(d.perTicketUsd, locale)}
          detail={(d) =>
            d.unpricedRuns > 0
              ? t('dashboard.ai.costUnpriced', { count: count(d.unpricedRuns) })
              : t('dashboard.ai.costDetail', {
                  total: formatUsd(d.totalUsd, locale),
                  tickets: count(d.tickets),
                })
          }
        />
        <Figure
          label={t('dashboard.ai.kb')}
          icon={Layers}
          tone="violet"
          value={data.kb}
          show={(d) =>
            t('dashboard.ai.kbValue', { stale: count(d.stale), published: count(d.published) })
          }
          info={
            <Info>
              {t('dashboard.ai.kbInfo', {
                days:
                  data.kb.status === 'ok' ? data.kb.data.staleAfterDays : DASHBOARD_KB_STALE_DAYS,
                assumed: t('dashboard.assumed'),
              })}
            </Info>
          }
          infoLabel={t('dashboard.ai.kbAbout')}
        />
        <Figure
          label={t('dashboard.ai.noTouch')}
          icon={Bot}
          tone="teal"
          value={data.noTouchRate}
          show={(d) => formatRate(d.rate, locale)}
        />
        <Figure
          label={t('dashboard.ai.verified')}
          icon={CircleCheck}
          tone="slate"
          value={data.verifiedVsAssumed}
          show={(d) =>
            t('dashboard.ai.verifiedValue', {
              verified: count(d.verified),
              assumed: count(d.assumed),
            })
          }
        />
        <Figure
          label={t('dashboard.ai.kbCoverage')}
          icon={Layers}
          tone="violet"
          value={data.kbCoverage}
          show={(d) => formatRate(d.rate, locale)}
        />
      </TileGrid>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{t('dashboard.ai.stagesTitle')}</h3>
        {data.stages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.ai.noStages')}</p>
        ) : (
          <ul className="grid gap-x-6 sm:grid-cols-2">
            {data.stages.map((entry) => {
              const stage = asStage(entry.stage);
              return (
                <li
                  key={entry.intent}
                  className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 py-1"
                >
                  <span className="min-w-0 truncate text-sm">{entry.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {entry.pinned ? (
                      <Lock
                        role="img"
                        aria-label={t('dashboard.ai.pinned')}
                        className="size-3.5 text-muted-foreground"
                      />
                    ) : null}
                    <StageBadge stage={stage} label={t(STAGE_LABEL_KEYS[stage])} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DashboardSection>
  );
}

// --- Team ----------------------------------------------------------------------------------------

export function TeamSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const { team } = ops;
  const count = (n: number) => formatCount(n, locale);
  return (
    <DashboardSection id="team" icon={Users} tone="indigo" title={t('dashboard.sections.team')}>
      <ElementInsight
        element="dashboard.ops.team"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.team"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.team.gaps')}
          icon={TriangleAlert}
          tone="amber"
          value={team.coverage}
          show={(d) => count(d.gaps)}
        />
        <Figure
          label={t('dashboard.team.carriedOver')}
          icon={Inbox}
          tone="indigo"
          value={team.carriedOver}
          show={(d) => count(d.items)}
        />
        <Figure
          label={t('dashboard.team.line')}
          icon={MessageSquare}
          tone="green"
          value={team.lineQuota}
          show={(d) =>
            d.limit === null
              ? t('dashboard.team.lineNoLimit', { used: count(d.used) })
              : t('dashboard.team.lineLimit', { used: count(d.used), limit: count(d.limit) })
          }
          detail={(d) => t('dashboard.team.lineDetail', { period: d.period })}
        />
      </TileGrid>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-sm font-medium text-foreground">{t('dashboard.team.perAgent')}</h3>
        {team.perAgent.status !== 'ok' ? (
          <SectionNote figure={team.perAgent} />
        ) : team.perAgent.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('dashboard.team.noAgents')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full max-w-xl border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('dashboard.team.name')}
                  </th>
                  <th scope="col" className="px-3 py-1 text-right font-medium">
                    {t('dashboard.team.open')}
                  </th>
                  <th scope="col" className="py-1 pl-3 text-right font-medium">
                    {t('dashboard.team.resolved')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.perAgent.data.map((agent) => (
                  <tr key={agent.userId} className="border-b border-border/60 last:border-b-0">
                    <th scope="row" className="py-1.5 pr-3 font-normal">
                      <span className="flex items-center gap-2">
                        <Avatar name={agent.name} id={agent.userId} size={24} />
                        <span className="min-w-0 truncate">{agent.name}</span>
                      </span>
                    </th>
                    <td className="tabular px-3 py-1.5 text-right">{count(agent.open)}</td>
                    <td className="tabular py-1.5 pl-3 text-right">{count(agent.resolved)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardSection>
  );
}

// --- Product usage -------------------------------------------------------------------------------

export function UsageSection({ ops }: SectionProps) {
  const { t, locale } = useI18n();
  const count = (n: number) => formatCount(n, locale);
  const { usage, health } = ops;
  return (
    <DashboardSection
      id="usage"
      icon={Activity}
      tone="purple"
      title={t('dashboard.sections.usage')}
    >
      <ElementInsight
        element="dashboard.ops.usage"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.usage"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      <TileGrid>
        <Figure
          label={t('dashboard.usage.anomalies')}
          icon={Activity}
          tone="purple"
          value={usage}
          show={(d) => count(d.anomalies)}
        />
        <Figure
          label={t('dashboard.usage.health')}
          icon={Gauge}
          tone="purple"
          value={health}
          show={(d) => count(d.scored)}
          detail={(d) =>
            t('dashboard.usage.healthDetail', { insufficient: count(d.insufficientData) })
          }
        />
      </TileGrid>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.usage.recent')}</h3>
          {usage.status !== 'ok' ? (
            <SectionNote figure={usage} />
          ) : usage.data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.usage.noRecent')}</p>
          ) : (
            <ul className="flex flex-col">
              {usage.data.recent.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 border-b border-border/60 py-1.5 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate font-medium">{row.metricKey}</span>
                  <span className="tabular text-muted-foreground">
                    {t('dashboard.usage.reading', {
                      observed: count(row.observed),
                      baseline: count(row.baseline),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium text-foreground">{t('dashboard.usage.lowest')}</h3>
          {health.status !== 'ok' ? (
            <SectionNote figure={health} />
          ) : health.data.lowest.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('dashboard.usage.noLowest')}</p>
          ) : (
            <ul className="flex flex-col">
              {health.data.lowest.map((row) => (
                <li
                  key={row.orgId}
                  className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate font-medium">{row.orgName}</span>
                  <span className="tabular text-muted-foreground">
                    {t('dashboard.usage.score', { score: row.score })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </DashboardSection>
  );
}

// --- Service status ------------------------------------------------------------------------------

const SERVICE_VIEW: Record<string, { icon: ChipIcon; tone: TintId }> = {
  operational: { icon: CircleCheck, tone: 'green' },
  degraded_performance: { icon: TriangleAlert, tone: 'amber' },
  partial_outage: { icon: OctagonAlert, tone: 'red' },
  major_outage: { icon: OctagonAlert, tone: 'red' },
  under_maintenance: { icon: Wrench, tone: 'sky' },
};

export function ServicesSection({ ops }: SectionProps) {
  const { t } = useI18n();
  const { services } = ops;
  return (
    <DashboardSection
      id="services"
      icon={Radio}
      tone="sky"
      title={t('dashboard.sections.services')}
    >
      <ElementInsight
        element="dashboard.ops.services"
        period={`d${String(ops.window.days)}`}
        followUp={
          <AskAiElement
            presentation="follow-up"
            element="dashboard.ops.services"
            period={`d${String(ops.window.days)}`}
          />
        }
      />
      {services.status !== 'ok' ? (
        <SectionNote figure={services} />
      ) : services.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.services.empty')}</p>
      ) : (
        <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
          {services.data.map((service) => {
            const view = SERVICE_VIEW[service.status] ?? { icon: Radio, tone: 'slate' as const };
            const known = service.status in SERVICE_VIEW;
            return (
              <li
                key={service.slug}
                className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 py-1"
              >
                <span className="min-w-0 truncate text-sm">
                  {service.name}
                  {service.public ? null : (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      {t('dashboard.services.internal')}
                    </span>
                  )}
                </span>
                <TintChip tone={view.tone} icon={view.icon}>
                  {known
                    ? t(
                        `ops.status.component.${service.status as keyof Messages['ops']['status']['component']}`,
                      )
                    : service.status}
                </TintChip>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardSection>
  );
}
