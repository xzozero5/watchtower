import { insightFactsResultSchema } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import type { InsightExecutor } from './facts.js';
import { buildAdminAiFacts, buildHomeStatusFacts, parseIsoWeek } from './index.js';

describe('parseIsoWeek (Unit)', () => {
  it('parses valid ISO week strings into Monday 00:00Z to next Monday 00:00Z', () => {
    const parsed = parseIsoWeek('2026-W45');
    expect(parsed.weekNumber).toBe(45);
    expect(parsed.year).toBe(2026);
    expect(parsed.end.getTime() - parsed.start.getTime()).toBe(7 * 86_400_000);
    expect(parsed.start.getUTCDay()).toBe(1); // Monday
    expect(parsed.end.getUTCDay()).toBe(1); // Monday

    const alt = parseIsoWeek('w2026-45');
    expect(alt.weekNumber).toBe(45);
    expect(alt.start.toISOString()).toBe(parsed.start.toISOString());

    const w1 = parseIsoWeek('2026-W01');
    expect(w1.weekNumber).toBe(1);
    expect(w1.start.getUTCDay()).toBe(1);
  });

  it('rejects invalid week numbers or malformed strings', () => {
    expect(() => parseIsoWeek('invalid-week')).toThrow(/invalid iso week format/);
    expect(() => parseIsoWeek('2026-W99')).toThrow(/invalid iso week number/);
    expect(() => parseIsoWeek('2026-W00')).toThrow(/invalid iso week number/);
  });
});

describe('Wave 9b Facts Invariance with Mock Executor (Unit)', () => {
  it('buildHomeStatusFacts works with in-memory executor stub without database', async () => {
    const mockExecutor: InsightExecutor = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ isOn: false }]),
          }),
          then: (resolve: (v: unknown) => void) => {
            resolve([{ active: 5, stage2: 3, stage3: 2 }]);
          },
        }),
      }),
      execute: () => Promise.resolve({ rows: [] }),
    } as unknown as InsightExecutor;

    const res = await buildHomeStatusFacts({
      executor: mockExecutor,
      now: new Date('2026-11-08T12:00:00.000Z'),
    });

    expect(insightFactsResultSchema.safeParse(res).success).toBe(true);
    expect(res.facts.find((f) => f.id === 'active_intents')?.value).toBe(5);
    expect(res.facts.find((f) => f.id === 'stage_2_intents')?.value).toBe(3);
    expect(res.facts.find((f) => f.id === 'stage_3_intents')?.value).toBe(2);
    expect(res.facts.find((f) => f.id === 'kill_switch')?.value).toBe('disabled');
    expect(res.facts.find((f) => f.id === 'autonomy_state')?.value).toBe('stage_3_active');
  });

  it('buildAdminAiFacts works with mock executor stub without database', async () => {
    const mockExecutor: InsightExecutor = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              { key: 'ai_kill_switch', isOn: false },
              { key: 'ai_stage_cap_pinned', isOn: true },
            ]),
        }),
      }),
      execute: () => Promise.resolve({ rows: [] }),
    } as unknown as InsightExecutor;

    const res = await buildAdminAiFacts({
      executor: mockExecutor,
      now: new Date('2026-11-08T12:00:00.000Z'),
    });

    expect(insightFactsResultSchema.safeParse(res).success).toBe(true);
    expect(res.facts.find((f) => f.id === 'kill_switch')?.value).toBe('disabled');
    expect(res.facts.find((f) => f.id === 'cap_pinned')?.value).toBe('enabled');
  });
});
