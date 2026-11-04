import type { GateCriterion, GateReport, Promotion } from '@watchtower/shared';

import { PEOPLE } from './console-fixtures';
import { uuid } from './fixtures';

const AT = '2026-11-02T03:00:00.000Z';

/** The intent the Stage 3 tests use: `billing` is at stage 2 in `makeAutonomy`. */
export const STAGE3_INTENT_ID = uuid(701);

const green = (
  key: string,
  value: GateCriterion['value'],
  threshold: GateCriterion['threshold'],
  basis: 'PRD' | 'ASSUMED',
): GateCriterion => ({
  key,
  pass: true,
  value,
  threshold,
  basis,
});

export function makeGateReport(
  status: GateReport['status'] = 'green',
  overrides: Partial<GateReport> = {},
): GateReport {
  const criteria: GateCriterion[] =
    status === 'green'
      ? [
          green('days_at_stage_2', 31, 28, 'PRD'),
          green('verified_resolution', 0.92, 0.88, 'PRD'),
          green('csat_parity', 4.5, 4.2, 'ASSUMED'),
          green('shadow_precision', 0.94, 0.9, 'ASSUMED'),
          {
            key: 'redaction_eval',
            pass: null,
            value: 'not_measured',
            threshold: 'pass',
            basis: 'ASSUMED',
          },
        ]
      : status === 'red'
        ? [
            green('days_at_stage_2', 31, 28, 'PRD'),
            { key: 'reopen_rate', pass: false, value: 0.2, threshold: 0.1, basis: 'PRD' },
            { key: 'shadow_precision', pass: null, value: null, threshold: 0.9, basis: 'ASSUMED' },
          ]
        : [
            { key: 'days_at_stage_2', pass: null, value: 3, threshold: 28, basis: 'PRD' },
            { key: 'shadow_precision', pass: null, value: null, threshold: 0.9, basis: 'ASSUMED' },
          ];
  return {
    id: uuid(1300),
    intentId: STAGE3_INTENT_ID,
    status,
    triggerKind: 'on_demand',
    windowStart: '2026-10-05T03:00:00.000Z',
    windowEnd: AT,
    metrics: { shadow: { evaluations: 60, decided: 50, accepted: 47, precision: 0.94 } },
    criteria,
    seedExcluded: true,
    generatedAt: AT,
    generatedBy: PEOPLE.head.id,
    ...overrides,
  };
}

export function makePromotion(
  status: Promotion['status'] = 'requested',
  overrides: Partial<Promotion> = {},
): Promotion {
  return {
    id: uuid(1400),
    intentId: STAGE3_INTENT_ID,
    gateReportId: uuid(1300),
    status,
    requestedBy: PEOPLE.mana.id,
    requestedByName: 'Mana K.',
    requestedAt: AT,
    requestReason: 'Four weeks green, ready for the pilot',
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionReason: null,
    selfApproved: false,
    appliedAt: null,
    ...overrides,
  };
}

/** The default Stage 3 reads, for `consoleApi({ overrides })` or the e2e backend. */
export function stage3Routes(
  options: {
    flag?: boolean;
    report?: GateReport | null;
    open?: Promotion | null;
    history?: Promotion[];
  } = {},
) {
  const report = options.report === undefined ? makeGateReport('green') : options.report;
  const open = options.open ?? null;
  return {
    'GET /v1/intents/:id/autonomy/promotion': {
      json: {
        intentId: STAGE3_INTENT_ID,
        autosendFlag: options.flag ?? true,
        latestReport: report,
        openPromotion: open,
      },
    },
    'GET /v1/intents/:id/autonomy/gate-reports': { json: { items: report ? [report] : [] } },
    'GET /v1/intents/:id/autonomy/promotions': {
      json: { items: [...(open ? [open] : []), ...(options.history ?? [])] },
    },
  };
}
