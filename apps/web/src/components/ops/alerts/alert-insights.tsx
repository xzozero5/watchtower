'use client';

import { EmptyState, Select } from '@watchtower/ui';
import { Layers, VolumeX } from 'lucide-react';
import { useState } from 'react';

import { LoadError } from '@/components/admin/admin-page';
import { AppLink } from '@/components/app-link';
import { AlertSeverityBadge, Moment, OpsSkeleton } from '@/components/ops/ops-bits';
import { IntroHint } from '@/components/intro-hint';
import { useI18n } from '@/i18n/provider';
import { useCorrelations, useNoise, useServices } from '@/lib/ops/queries';

/**
 * Alerts the correlation engine grouped (R-3.6). A group is a proposal, never an incident by
 * itself: the page says so and links to the incident once a person opened one.
 */
export function CorrelationGroups() {
  const { t } = useI18n();
  const groups = useCorrelations(true);
  const services = useServices();
  return (
    <section aria-labelledby="alert-groups" className="flex flex-col gap-2">
      <h2 id="alert-groups" className="text-sm font-semibold">
        {t('ops.alerts.groups.heading')}
      </h2>
      <IntroHint topic={t('ops.alerts.groups.heading')}>{t('ops.alerts.groups.intro')}</IntroHint>
      {groups.isPending ? (
        <OpsSkeleton rows={3} />
      ) : groups.isError ? (
        <LoadError onRetry={() => void groups.refetch()} />
      ) : groups.data.items.length === 0 ? (
        <EmptyState icon={<Layers />} title={t('ops.alerts.groups.empty')} />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {groups.data.items.map((group) => (
            <li
              key={group.correlationId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-inner bg-surface px-3.5 py-2.5 shadow-card text-sm"
            >
              <AlertSeverityBadge severity={group.severity} />
              <span className="font-medium">
                {services.data?.items.find((item) => item.id === group.serviceId)?.name ??
                  t('ops.alerts.unmapped')}
              </span>
              <span>
                {t('ops.alerts.groups.counts', { count: group.alerts, open: group.openAlerts })}
              </span>
              <span className="text-muted-foreground">
                <Moment iso={group.lastSeenAt} />
              </span>
              {group.incidentId ? (
                <AppLink
                  href={`/incidents?incident=${encodeURIComponent(group.incidentId)}`}
                  className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t('ops.alerts.actions.openIncident')}
                </AppLink>
              ) : (
                <span className="text-muted-foreground">{t('ops.alerts.groups.noIncident')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const DAY_CHOICES = [7, 30] as const;

/** Noise per rule over the last days (R-3.11): how many alerts a person acted on and how many ended on their own. */
export function NoiseReport() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<number>(7);
  const noise = useNoise(days, true);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  return (
    <section aria-labelledby="alert-noise" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="alert-noise" className="text-sm font-semibold">
          {t('ops.alerts.noise.heading')}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          {t('ops.alerts.noise.window')}
          <Select
            value={days}
            onChange={(event) => {
              setDays(Number(event.target.value));
            }}
          >
            {DAY_CHOICES.map((value) => (
              <option key={value} value={value}>
                {t('ops.alerts.noise.days', { count: value })}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <IntroHint topic={t('ops.alerts.noise.heading')}>{t('ops.alerts.noise.intro')}</IntroHint>
      {noise.isPending ? (
        <OpsSkeleton rows={4} />
      ) : noise.isError ? (
        <LoadError onRetry={() => void noise.refetch()} />
      ) : noise.data.items.length === 0 ? (
        <EmptyState icon={<VolumeX />} title={t('ops.alerts.noise.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">{t('ops.alerts.noise.heading')}</caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t('ops.alerts.noise.rule')}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {t('ops.alerts.noise.alerts')}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {t('ops.alerts.noise.actionable')}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {t('ops.alerts.noise.noise')}
                </th>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {t('ops.alerts.noise.stillOpen')}
                </th>
                <th scope="col" className="py-1.5 pl-3 font-medium">
                  {t('ops.alerts.noise.ratio')}
                </th>
              </tr>
            </thead>
            <tbody>
              {noise.data.items.map((rule) => (
                <tr key={`${rule.source}-${rule.title}`} className="border-t border-border">
                  <th scope="row" className="py-1.5 pr-3 font-normal break-words">
                    {rule.title}
                    <span className="block text-xs text-muted-foreground">
                      {t(`ops.alerts.source.${rule.source}`)}
                    </span>
                  </th>
                  <td className="tabular px-3 py-1.5">{rule.alerts}</td>
                  <td className="tabular px-3 py-1.5">{rule.actionable}</td>
                  <td className="tabular px-3 py-1.5">{rule.noise}</td>
                  <td className="tabular px-3 py-1.5">{rule.stillOpen}</td>
                  <td className="tabular py-1.5 pl-3">
                    {rule.actionableRatio === null
                      ? t('ops.alerts.noise.notJudged')
                      : percent.format(rule.actionableRatio)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
