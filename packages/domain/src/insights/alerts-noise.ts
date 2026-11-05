import type { InsightFact, InsightFactsResult } from '@watchtower/shared';

import { readAlertNoiseByService, readAlertNoiseTotals } from '../alerts/noise.js';
import { driverFacts, finishFacts, metric, state, type InsightBuildOptions } from './facts.js';
import { share, topDrivers } from './primitives.js';

export interface AlertsNoiseOptions extends InsightBuildOptions {
  /** The window of `GET /v1/alerts/noise?days=`, 1 to 90. */
  readonly days: number;
}

/**
 * `alerts.noise`: how many alerts the window held, how many a person or an incident acted on, how many
 * resolved by themselves, and which services account for the most noise. No alert title or summary: those
 * come from webhooks (C-14), so the drivers are services, a catalog a staff member keeps.
 */
export async function buildAlertsNoiseFacts(
  options: AlertsNoiseOptions,
): Promise<InsightFactsResult> {
  const { executor, days } = options;
  const [totals, byService] = await Promise.all([
    readAlertNoiseTotals(executor, days),
    readAlertNoiseByService(executor, days),
  ]);
  const judged = totals.actionable + totals.noise;
  const noisePercent = share(totals.noise, totals.alerts);
  const facts: InsightFact[] = [
    metric('window_days', days, {
      th: `ช่วงเวลา ${String(days)} วัน`,
      en: `Window of ${String(days)} days`,
    }),
    metric('alerts', totals.alerts, {
      th: `alert ${String(totals.alerts)} รายการใน ${String(days)} วัน`,
      en: `${String(totals.alerts)} alerts in ${String(days)} days`,
    }),
    metric('actionable', totals.actionable, {
      th: `${String(totals.actionable)} รายการมีคนรับทราบหรืออยู่ใน incident`,
      en: `${String(totals.actionable)} were acknowledged or part of an incident`,
    }),
    metric('noise', totals.noise, {
      th: `${String(totals.noise)} รายการหายเองโดยไม่มีคนทำอะไร`,
      en: `${String(totals.noise)} resolved by themselves with no action`,
    }),
    metric('still_open', totals.stillOpen, {
      th: `${String(totals.stillOpen)} รายการยังเปิดอยู่และยังไม่ถูกตัดสิน`,
      en: `${String(totals.stillOpen)} still open and not judged yet`,
    }),
  ];
  if (noisePercent !== null) {
    facts.push(
      metric('noise_pct', noisePercent, {
        th: `${String(noisePercent)}% ของ alert เป็น noise`,
        en: `${String(noisePercent)}% of alerts were noise`,
      }),
    );
  }
  facts.push(
    state(
      'noise_state',
      judged === 0 ? 'unjudged' : totals.noise > totals.actionable ? 'noisy' : 'ok',
      {
        th: 'สถานะ noise ของ alert',
        en: 'Alert noise state',
      },
    ),
    ...driverFacts(
      'service_driver',
      { th: 'service ที่มี noise มากสุด', en: 'Service with the most noise' },
      topDrivers(
        'service',
        byService.map((row) => ({ id: row.id, name: row.name, count: row.noise })),
      ),
    ),
  );
  return finishFacts(facts, options.now ?? new Date(), options.view);
}
