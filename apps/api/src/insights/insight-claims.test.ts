import type { InsightFact, InsightStoredClaim } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  NO_ACCESS,
  factViews,
  refKey,
  refsOf,
  restoreNarration,
  templateClaims,
  type ResolvedRef,
} from './insight-claims.js';

const INTENT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PERSON_A = '33333333-3333-4333-8333-333333333333';
const PERSON_B = '44444444-4444-4444-8444-444444444444';

const metric = (id: string, value: number, en: string, th = en): InsightFact => ({
  id,
  kind: 'metric',
  value,
  display: { th, en },
});

const allowed = (label: string, href?: string): ResolvedRef => ({
  allowed: true,
  label,
  ...(href === undefined ? {} : { href }),
});
const denied: ResolvedRef = { allowed: false, label: '' };

describe('aggregate narration provenance', () => {
  const fact = metric('open', 12, '12 open tickets', 'เปิดอยู่ 12 รายการ');
  const stored: InsightStoredClaim[] = [
    { text: '12 open tickets', evidence: [{ kind: 'aggregate', factId: 'open' }] },
  ];
  it('round-trips a system metric without inventing an entity or link', () => {
    for (const masked of [false, true]) {
      const [claim] = restoreNarration(stored, {
        facts: [fact],
        locale: 'en',
        resolved: new Map(),
        masked,
      });
      expect(claim?.uncited).toBe(false);
      expect(claim?.evidence).toEqual([{ kind: 'metric', label: '12 open tickets' }]);
      expect(refsOf([fact], stored)).toEqual([]);
    }
  });
  it('drops a claim when its fact is absent or no longer visible, or disguises an entity', () => {
    for (const facts of [[], [{ ...fact, ref: { kind: 'org' as const, id: ORG } }]]) {
      expect(
        restoreNarration(stored, {
          facts,
          locale: 'en',
          resolved: new Map(),
          masked: true,
        }),
      ).toEqual([]);
    }
  });
  it('rejects fabricated ids or links on aggregate evidence', () => {
    const bad = [{ text: '12', evidence: [{ kind: 'aggregate', factId: 'open', id: ORG }] }];
    expect(
      restoreNarration(bad, {
        facts: [fact],
        locale: 'en',
        resolved: new Map(),
        masked: false,
      }),
    ).toEqual([]);
  });
});

describe('mode F sentences by template, in the viewer language', () => {
  const facts: InsightFact[] = [
    metric('open', 12, '12 open'),
    metric('at_risk', 2, '2 at risk'),
    metric('breached', 1, '1 breached'),
    {
      id: 'queue_driver_1',
      kind: 'driver',
      value: 5,
      display: { th: 'คิว: Q (5)', en: 'Queue: Q (5)' },
      ref: { kind: 'queue', id: INTENT },
    },
  ];
  const resolved = new Map([[refKey({ kind: 'queue', id: INTENT }), allowed('Billing')]]);

  it('renders one language per sentence and cites the facts behind it', () => {
    const en = templateClaims('dashboard.ops.sla', facts, 'en', resolved);
    expect(en.map((claim) => claim.text)).toEqual([
      '12 open',
      '3 items close to breaching SLA',
      'Mostly from Billing (5 items)',
    ]);
    const th = templateClaims('dashboard.ops.sla', facts, 'th', resolved);
    expect(th.map((claim) => claim.text)).toEqual([
      'เปิดอยู่ 12 รายการ',
      '3 รายการใกล้ผิด SLA',
      'ส่วนใหญ่มาจาก Billing (5 รายการ)',
    ]);
    for (const claim of [...en, ...th]) {
      expect(claim.uncited).toBe(false);
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
    // The text of one sentence is never half Thai and half English.
    for (const claim of th) expect(claim.text).not.toMatch(/items|open|Mostly/);
    for (const claim of en) expect(claim.text).not.toMatch(/[ก-๙]/);
  });

  it('names a driver the viewer cannot open as "No access", never by its name', () => {
    const noAccess = new Map([[refKey({ kind: 'queue', id: INTENT }), denied]]);
    const claims = templateClaims('dashboard.ops.sla', facts, 'en', noAccess);
    const driver = claims.at(-1);
    expect(driver?.text).toBe(`Mostly from ${NO_ACCESS.en} (5 items)`);
    expect(driver?.evidence[0]).toEqual({ kind: 'data', label: NO_ACCESS.en });
  });

  it('says nothing for an element without recipes, and nothing the facts do not say', () => {
    expect(templateClaims('shift.overview', facts, 'en', resolved)).toEqual([]);
    expect(templateClaims('dashboard.ops.sla', [], 'en', new Map())).toEqual([]);
  });

  it('uses delta_up, delta_down and delta_flat by the sign and the flat band', () => {
    const delta = (value: number): InsightFact => ({
      id: 'created_24h_delta',
      kind: 'delta',
      value,
      display: { th: 'x', en: 'x' },
    });
    const text = (value: number) =>
      templateClaims('dashboard.ops.volume', [delta(value)], 'en', new Map())[0]?.text;
    expect(text(18)).toBe('Tickets created in the last 24 hours is up 18% on the 7-day average');
    expect(text(-18)).toBe('Tickets created in the last 24 hours is down 18% on the 7-day average');
    expect(text(1)).toBe('Tickets created in the last 24 hours is in line with the 7-day average');
  });
});

describe('persons in facts', () => {
  const person: InsightFact = {
    id: 'person_a_held',
    kind: 'metric',
    value: 3,
    display: { th: '{person_a} ถือ 3 รายการ', en: '{person_a} holds 3 open tickets' },
    ref: { kind: 'user', id: PERSON_A },
  };

  it('restores the placeholder with the name when the viewer may see that person, else No access', () => {
    const yes = new Map([[refKey({ kind: 'user', id: PERSON_A }), allowed('Somchai')]]);
    expect(factViews([person], 'en', yes)[0]?.text).toBe('Somchai holds 3 open tickets');
    expect(factViews([person], 'th', yes)[0]?.text).toBe('Somchai ถือ 3 รายการ');
    const no = new Map([[refKey({ kind: 'user', id: PERSON_A }), denied]]);
    expect(factViews([person], 'en', no)[0]?.text).toBe(`${NO_ACCESS.en} holds 3 open tickets`);
    expect(factViews([person], 'en', new Map())[0]?.text).toBe(
      `${NO_ACCESS.en} holds 3 open tickets`,
    );
  });
});

describe('restoring a stored narration', () => {
  const facts: InsightFact[] = [
    metric('created', 40, '40 tickets in 7 days'),
    {
      id: 'person_a_held',
      kind: 'metric',
      value: 3,
      display: { th: '{person_a} ถือ 3', en: '{person_a} holds 3' },
      ref: { kind: 'user', id: PERSON_A },
    },
  ];
  const stored: InsightStoredClaim[] = [
    {
      text: '[PERSON_1] holds 3 of the 40 tickets',
      evidence: [
        { kind: 'user', id: PERSON_A, factId: 'person_a_held' },
        { kind: 'intent', id: INTENT, factId: 'created' },
      ],
    },
  ];
  const resolved = new Map<string, ResolvedRef>([
    [refKey({ kind: 'user', id: PERSON_A }), allowed('Somchai')],
    [refKey({ kind: 'intent', id: INTENT }), allowed('Refund', '/admin/intents/x')],
  ]);

  it('puts the name back and restores the chips with links the viewer may follow', () => {
    const [claim] = restoreNarration(stored, { facts, locale: 'en', resolved, masked: false });
    expect(claim?.text).toBe('Somchai holds 3 of the 40 tickets');
    expect(claim?.evidence).toEqual([
      { kind: 'person', label: 'Somchai', ref: { kind: 'person', id: PERSON_A } },
      {
        kind: 'intent',
        label: 'Refund',
        href: '/admin/intents/x',
        ref: { kind: 'intent', id: INTENT },
      },
    ]);
    expect(claim?.uncited).toBe(false);
  });

  it('shows a "No access" chip, without a label or a link, for a ref the viewer cannot open', () => {
    const none = new Map<string, ResolvedRef>([
      [refKey({ kind: 'user', id: PERSON_A }), denied],
      [refKey({ kind: 'intent', id: INTENT }), denied],
    ]);
    const [claim] = restoreNarration(stored, {
      facts,
      locale: 'th',
      resolved: none,
      masked: false,
    });
    expect(claim?.text).toBe(`${NO_ACCESS.th} holds 3 of the 40 tickets`);
    expect(claim?.evidence).toEqual([
      { kind: 'person', label: NO_ACCESS.th },
      { kind: 'intent', label: NO_ACCESS.th },
    ]);
    expect(JSON.stringify(claim)).not.toContain('Somchai');
    expect(JSON.stringify(claim)).not.toContain(PERSON_A);
  });

  it('never leaves a raw placeholder: a token with no person behind it is "No access" too', () => {
    const odd = [
      {
        text: '[PERSON_2] and [EMAIL_1] and [PERSON_1]',
        evidence: [{ kind: 'user', id: PERSON_A, factId: 'person_a_held' }],
      },
    ];
    const [claim] = restoreNarration(odd, { facts, locale: 'en', resolved, masked: false });
    expect(claim?.text).toBe(`${NO_ACCESS.en} and ${NO_ACCESS.en} and Somchai`);
    expect(claim?.text).not.toMatch(/\[[A-Z_]+_\d+\]/);
  });

  it('maps the n-th distinct person to [PERSON_n]', () => {
    const two = [
      {
        text: '[PERSON_1] and [PERSON_2]',
        evidence: [
          { kind: 'user', id: PERSON_A, factId: 'person_a_held' },
          { kind: 'user', id: PERSON_B, factId: 'person_a_held' },
          { kind: 'user', id: PERSON_A, factId: 'created' },
        ],
      },
    ];
    const names = new Map<string, ResolvedRef>([
      [refKey({ kind: 'user', id: PERSON_A }), allowed('A')],
      [refKey({ kind: 'user', id: PERSON_B }), allowed('B')],
    ]);
    expect(
      restoreNarration(two, { facts, locale: 'en', resolved: names, masked: false })[0]?.text,
    ).toBe('A and B');
  });

  it('drops, for a masked viewer, a claim that cites a customer or says a number the masked facts lack', () => {
    const claims = [
      {
        text: 'Org X has 40 tickets',
        evidence: [{ kind: 'org', id: ORG, factId: 'created' }],
      },
      {
        text: '40 tickets in 7 days',
        evidence: [{ kind: 'intent', id: INTENT, factId: 'created' }],
      },
      {
        text: '99 tickets in 7 days',
        evidence: [{ kind: 'intent', id: INTENT, factId: 'created' }],
      },
    ];
    const kept = restoreNarration(claims, { facts, locale: 'en', resolved, masked: true });
    expect(kept.map((claim) => claim.text)).toEqual(['40 tickets in 7 days']);
    const all = restoreNarration(claims, { facts, locale: 'en', resolved, masked: false });
    expect(all).toHaveLength(3);
  });

  it('returns nothing for stored data that is not a valid narration', () => {
    for (const bad of [null, {}, [], [{ text: 'x', evidence: [] }], 'text']) {
      expect(restoreNarration(bad, { facts, locale: 'en', resolved, masked: false })).toEqual([]);
    }
  });

  it('lists the refs of facts and narration once each', () => {
    const refs = refsOf(facts, [
      {
        text: 't',
        evidence: [{ kind: 'user', id: PERSON_A, factId: 'person_a_held' }],
      },
    ]);
    expect(refs).toEqual([{ kind: 'user', id: PERSON_A }]);
  });
});

describe('Wave 9b Mode F templates (T-420)', () => {
  it('renders home.status template in TH and EN', () => {
    const facts: InsightFact[] = [
      metric('active_intents', 15, '15 active intents'),
      metric('stage_3_intents', 4, '4 stage 3 intents'),
      {
        id: 'kill_switch',
        kind: 'state',
        value: 'enabled',
        display: { th: 'Kill switch เปิดอยู่', en: 'Kill switch is active' },
      },
    ];
    const en = templateClaims('home.status', facts, 'en', new Map());
    expect(en[0]?.text).toBe('15 active intents (4 at stage 3), kill switch is active');

    const th = templateClaims('home.status', facts, 'th', new Map());
    expect(th[0]?.text).toBe('15 intent ใช้งานอยู่ (4 อยู่ stage 3), kill switch เปิดอยู่');
  });

  it('renders admin.intent.gate status in localized terms', () => {
    const factsPass: InsightFact[] = [
      { id: 'gate_status', kind: 'state', value: 'pass', display: { th: 'ผ่าน', en: 'pass' } },
      metric('criteria_pass', 7, '7 passed'),
      metric('criteria_fail', 0, '0 failed'),
    ];
    const en = templateClaims('admin.intent.gate', factsPass, 'en', new Map());
    expect(en[0]?.text).toBe('Latest gate report: pass (7 passed, 0 failed)');

    const th = templateClaims('admin.intent.gate', factsPass, 'th', new Map());
    expect(th[0]?.text).toBe('รายงาน Gate ล่าสุด: ผ่าน (ผ่าน 7 ข้อ, ไม่ผ่าน 0 ข้อ)');
  });

  it('renders queue.list summary with at_risk and breached sum', () => {
    const facts: InsightFact[] = [
      metric('my_open', 5, '5 held'),
      metric('my_at_risk', 1, '1 risk'),
      metric('my_breached', 2, '2 breached'),
      metric('unassigned_open', 8, '8 unassigned'),
    ];
    const en = templateClaims('queue.list', facts, 'en', new Map());
    expect(en[0]?.text).toBe('You hold 5 open tickets (3 at risk), 8 unassigned tickets open');
    const th = templateClaims('queue.list', facts, 'th', new Map());
    expect(th[0]?.text).toBe(
      'คุณถืออยู่ 5 รายการ (3 เสี่ยงผิด SLA), ค้างที่ยังไม่มอบหมาย 8 รายการ',
    );
  });

  it('renders admin.ai summary with cost formatted', () => {
    const facts: InsightFact[] = [
      {
        id: 'kill_switch',
        kind: 'state',
        value: 'disabled',
        display: { th: 'ปิด', en: 'inactive' },
      },
      metric('tokens_today', 45000, '45k tokens'),
      metric('cost_today_usd', 1.25, '$1.25 USD'),
    ];
    const en = templateClaims('admin.ai', facts, 'en', new Map());
    expect(en[0]?.text).toBe('Kill switch is inactive, today: 45,000 tokens ($1.25 USD)');
    const th = templateClaims('admin.ai', facts, 'th', new Map());
    expect(th[0]?.text).toBe('Kill switch ปิดอยู่, การใช้งานวันนี้: 45,000 tokens ($1.25 USD)');
  });

  it('renders dashboard.ops.ai with cost_usd and error counts correctly', () => {
    const facts: InsightFact[] = [
      metric('total_runs', 50, '50 runs'),
      metric('cost_usd', 12.5, '$12.5 USD'),
      metric('error_count', 2, '2 errors'),
      metric('fallback_count', 1, '1 fallback'),
    ];
    const en = templateClaims('dashboard.ops.ai', facts, 'en', new Map());
    expect(en[0]?.text).toContain('$12.5 USD');
    expect(en[0]?.text).toContain('3 errors');

    const th = templateClaims('dashboard.ops.ai', facts, 'th', new Map());
    expect(th[0]?.text).toContain('12.5 USD');
    expect(th[0]?.text).toContain('3 ครั้ง');
  });

  it('renders admin.intent.gate with insufficient_data translated to pure Thai without raw English token', () => {
    const facts: InsightFact[] = [
      {
        id: 'gate_status',
        kind: 'state',
        value: 'insufficient_data',
        display: { th: 'ข้อมูลยังไม่เพียงพอ', en: 'insufficient data' },
      },
      metric('criteria_pass', 2, '2 passed'),
      metric('criteria_fail', 1, '1 failed'),
    ];
    const en = templateClaims('admin.intent.gate', facts, 'en', new Map());
    expect(en[0]?.text).toBe('Latest gate report: insufficient data (2 passed, 1 failed)');

    const th = templateClaims('admin.intent.gate', facts, 'th', new Map());
    expect(th[0]?.text).toBe('รายงาน Gate ล่าสุด: ข้อมูลยังไม่เพียงพอ (ผ่าน 2 ข้อ, ไม่ผ่าน 1 ข้อ)');
    expect(th[0]?.text).not.toContain('insufficient_data');
  });
});
