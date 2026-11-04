import type { CeoView } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { figureFacts } from './weekly-brief-facts.js';

const view: CeoView = {
  generatedAt: '2026-11-09T03:00:00.000Z',
  window: { from: '2026-11-03T00:00:00.000Z', to: '2026-11-09T03:00:00.000Z', days: 7 },
  previous: { from: '2026-10-27T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' },
  seedExcluded: false,
  kpis: {
    volume: { status: 'ok', data: { value: 120, previous: 100, samples: 120 } },
    firstResponse: { status: 'ok', data: { value: 1800, previous: 3600, samples: 90 } },
    resolution: { status: 'ok', data: { value: 7200, previous: null, samples: 80 } },
    sla: { status: 'ok', data: { value: 0.9, previous: 0.95, samples: 100 } },
    csat: { status: 'ok', data: { value: 4.5, previous: 4.4, samples: 30 } },
    aiHandled: { status: 'ok', data: { value: 0.4, previous: null, samples: 50 } },
    verifiedResolution: { status: 'not_available', reason: 'needs_grader' },
    automationSavings: { status: 'not_available', reason: 'no_data' },
  },
  formula: {
    assumed: true,
    minutesPerTicket: 10,
    staffCostUsdPerHour: null,
    aiHandledTickets: 20,
    noTouchTickets: 8,
    hours: 3.3,
    savedUsd: null,
    aiCostUsd: 2.5,
    netUsd: null,
    aiCostPerResolvedTicketUsd: 0.05,
    previousAiCostPerResolvedTicketUsd: null,
  },
  externalTiles: [
    {
      key: 'uptime',
      label: 'Platform uptime',
      unit: '%',
      higherIsBetter: true,
      value: 99.9,
      previous: 99.5,
      observedAt: '2026-11-08T00:00:00.000Z',
    },
  ],
};

describe('figureFacts', () => {
  it('turns every KPI of the CEO view into one fact with the figure, the period before and the samples', () => {
    const facts = figureFacts(view, 'en');
    expect(facts).toHaveLength(9);
    const byLabel = Object.fromEntries(facts.map((fact) => [fact.label, fact.text]));
    expect(byLabel['SLA compliance']).toBe(
      'SLA compliance: 90% (period before 95%; from 100 samples).',
    );
    expect(byLabel['First response (median)']).toContain('30 min');
    expect(byLabel['First response (median)']).toContain('period before 1 h');
    expect(byLabel['CSAT']).toContain('4.5/5');
    expect(byLabel['Time to resolve (median)']).toContain('no figure to compare');
    expect(facts.every((fact) => fact.kind === 'data' && fact.href === '/dashboard/ceo')).toBe(
      true,
    );
  });

  it('says "not available" and gives no number for a figure with nothing behind it (N5)', () => {
    const byLabel = Object.fromEntries(
      figureFacts(view, 'en').map((fact) => [fact.label, fact.text]),
    );
    expect(byLabel['Verified resolutions']).toBe(
      'Verified resolutions: not available, no ticket has been graded yet.',
    );
    expect(byLabel['Automation savings']).toBe('Automation savings: no data in this period.');
    expect(byLabel['Verified resolutions']).not.toMatch(/\d/);
  });

  it('marks the savings figure as an assumption of the formula', () => {
    const savings = figureFacts(
      {
        ...view,
        kpis: {
          ...view.kpis,
          automationSavings: { status: 'ok', data: { value: 3.3, previous: 2, samples: 20 } },
        },
      },
      'en',
    ).find((fact) => fact.label === 'Automation savings');
    expect(savings?.text).toContain('assumed formula: 10 minutes per AI-assisted ticket');
  });

  it('includes the tiles fed from outside, with the value before', () => {
    const tile = figureFacts(view, 'en').find((fact) => fact.label === 'Platform uptime');
    expect(tile?.text).toContain('99.9 %');
    expect(tile?.text).toContain('before 99.5 %');
    expect(tile?.text).toContain('2026-11-08');
  });

  it('writes Thai when the brief is Thai', () => {
    const facts = figureFacts(view, 'th');
    expect(facts.find((fact) => fact.label === 'SLA ที่ทำได้')?.text).toContain('ช่วงก่อนหน้า 95%');
  });
});
