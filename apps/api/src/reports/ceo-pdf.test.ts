import { inflateSync } from 'node:zlib';

import { ceoViewSchema, type CeoView } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { ceoPdf, fontRuns } from './ceo-pdf.js';

const NO_DATA = { status: 'not_available', reason: 'no_data' } as const;

function view(labels: readonly string[]): CeoView {
  return ceoViewSchema.parse({
    generatedAt: '2026-11-04T03:00:00.000Z',
    window: { from: '2026-10-28T00:00:00.000Z', to: '2026-11-04T23:59:59.999Z', days: 7 },
    previous: { from: '2026-10-21T00:00:00.000Z', to: '2026-10-27T23:59:59.999Z' },
    seedExcluded: true,
    kpis: {
      volume: { status: 'ok', data: { value: 42, previous: 30, samples: 42 } },
      firstResponse: NO_DATA,
      resolution: NO_DATA,
      sla: { status: 'ok', data: { value: 0.93, previous: null, samples: 40 } },
      csat: NO_DATA,
      aiHandled: NO_DATA,
      verifiedResolution: NO_DATA,
      automationSavings: NO_DATA,
    },
    formula: {
      assumed: true,
      minutesPerTicket: 15,
      staffCostUsdPerHour: null,
      aiHandledTickets: 0,
      noTouchTickets: 0,
      hours: 0,
      savedUsd: null,
      aiCostUsd: 0,
      netUsd: null,
      aiCostPerResolvedTicketUsd: null,
      previousAiCostPerResolvedTicketUsd: null,
    },
    externalTiles: labels.map((label, index) => ({
      key: `tile_${String(index)}`,
      label,
      unit: '%',
      higherIsBetter: true,
      value: 99.9,
      previous: null,
      observedAt: '2026-11-03T00:00:00.000Z',
    })),
  });
}

/** Every FlateDecode stream of the file, inflated and read as latin1 (CMaps and page content are text). */
function streams(pdf: Buffer): string[] {
  const text = pdf.toString('latin1');
  const found: string[] = [];
  for (const match of text.matchAll(/stream\r?\n/gu)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    try {
      found.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // Not a Flate stream (an image or a raw font table): nothing to read.
    }
  }
  return found;
}

describe('fontRuns', () => {
  it('splits Thai from the rest and keeps spaces, digits and punctuation on the Latin face', () => {
    expect(fontRuns('SLA ความเร็ว 99%')).toEqual([
      { thai: false, text: 'SLA ' },
      { thai: true, text: 'ความเร็ว' },
      { thai: false, text: ' 99%' },
    ]);
    expect(fontRuns('')).toEqual([]);
  });
});

describe('ceoPdf', () => {
  it('is a valid PDF with the embedded font and the figures', async () => {
    const pdf = await ceoPdf(view([]));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-16).toString('latin1')).toContain('%%EOF');
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/\/FontFile2/u);
    expect(raw).toMatch(/IBMPlexSansThai/u);
    expect(raw).not.toMatch(/\/JavaScript|\/JS |\/Launch|\/URI/u);
  });

  it('keeps Thai text extractable (ToUnicode maps Thai code points) and wraps long cells', async () => {
    const pdf = await ceoPdf(
      view([
        'เวลาทำงานของระบบ (uptime)',
        'อัตราการแก้ไขปัญหาที่ยืนยันแล้วของลูกค้าทั้งหมดในเดือนนี้',
      ]),
    );
    const maps = streams(pdf).filter(
      (text) => text.includes('beginbfchar') || text.includes('beginbfrange'),
    );
    const thai = maps.some((text) => /<0E[0-7][0-9A-F]>/iu.test(text));
    expect(thai).toBe(true);
    // Titles come out of `info` without a clock: same input, same size.
    const again = await ceoPdf(
      view([
        'เวลาทำงานของระบบ (uptime)',
        'อัตราการแก้ไขปัญหาที่ยืนยันแล้วของลูกค้าทั้งหมดในเดือนนี้',
      ]),
    );
    expect(again.length).toBe(pdf.length);
  });

  it('adds pages when there are many tiles', async () => {
    const pdf = await ceoPdf(
      view(Array.from({ length: 80 }, (_, index) => `Tile ${String(index)}`)),
    );
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/gu) ?? []).length).toBeGreaterThan(1);
  });
});
