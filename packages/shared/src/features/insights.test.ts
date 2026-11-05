import { describe, expect, it } from 'vitest';

import { PERMISSIONS } from '../rbac.js';
import {
  INSIGHT_ELEMENTS,
  INSIGHT_ELEMENT_KEYS,
  INSIGHT_MASKED_REF_KINDS,
  INSIGHT_STATES,
  INSIGHT_STATE_COPY,
  INSIGHT_TEMPLATES,
  NARRATED_INSIGHT_ELEMENTS,
  extractInsightNumbers,
  insightElementSchema,
  insightFactSchema,
  insightStateLabel,
  insightStoredClaimSchema,
  insightTemplateParams,
  isInsightPeriodAllowed,
  numbersSubsetOfFacts,
  renderInsightTemplate,
  renderInsightTemplateClaim,
  selectInsightState,
  type InsightFact,
  type InsightTemplateId,
} from './insights.js';

describe('element registry', () => {
  it('has a row for every key and every row passes its schema', () => {
    expect(Object.keys(INSIGHT_ELEMENTS).sort()).toEqual([...INSIGHT_ELEMENT_KEYS].sort());
    for (const key of INSIGHT_ELEMENT_KEYS) {
      const parsed = insightElementSchema.safeParse(INSIGHT_ELEMENTS[key]);
      expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('fails when a non-X element lacks a mode, a rule or the Ask AI flag', () => {
    for (const key of INSIGHT_ELEMENT_KEYS) {
      const row = INSIGHT_ELEMENTS[key];
      expect(['F', 'N', 'R', 'X']).toContain(row.mode);
      if (row.mode === 'X') {
        expect(row.askAi, key).toBe(false);
      } else {
        expect(row.askAi, `${key} needs the "Ask AI" button`).toBe(true);
        expect(row.rule, `${key} needs a rule`).not.toBeNull();
      }
    }
    const broken = { ...INSIGHT_ELEMENTS['alerts.noise'], askAi: false };
    expect(insightElementSchema.safeParse(broken).success).toBe(false);
    const noRule = { ...INSIGHT_ELEMENTS['alerts.noise'], rule: null };
    expect(insightElementSchema.safeParse(noRule).success).toBe(false);
    const noMode = { ...INSIGHT_ELEMENTS['alerts.noise'], mode: undefined };
    expect(insightElementSchema.safeParse(noMode).success).toBe(false);
  });

  it('only uses permissions that exist', () => {
    for (const key of INSIGHT_ELEMENT_KEYS) {
      const rule = INSIGHT_ELEMENTS[key].rule;
      if (rule === null) continue;
      const names = 'all' in rule ? rule.all : rule.anyOf;
      for (const name of names) expect(name in PERMISSIONS, `${key}: ${name}`).toBe(true);
    }
  });

  it('keeps admin pages F only and people elements under a pii kind (N3, section 9.9)', () => {
    const admin = [
      'admin.intents',
      'admin.intent.gate',
      'admin.ai',
      'admin.integrations',
      'admin.outbox',
      'admin.queues',
      'statuspage.admin',
    ] as const;
    for (const key of admin) {
      expect(INSIGHT_ELEMENTS[key].mode, key).toBe('F');
      expect(INSIGHT_ELEMENTS[key].adminFactsOnly, key).toBe(true);
    }
    for (const key of ['shift.overview', 'home.team', 'dashboard.ops.team'] as const) {
      expect(INSIGHT_ELEMENTS[key].mode).toBe('N');
      expect(INSIGHT_ELEMENTS[key].personRefs).toBe('others');
      expect(INSIGHT_ELEMENTS[key].piiKind).toBeDefined();
    }
    expect(INSIGHT_ELEMENTS['home.my_work'].personRefs).toBe('self');
    expect(INSIGHT_ELEMENTS['home.my_work'].scope).toBe('user');
  });

  it('matches the pilot wave and the R / X rows of ADR-029 9.1', () => {
    const wave9a = INSIGHT_ELEMENT_KEYS.filter((k) => INSIGHT_ELEMENTS[k].wave === '9a').sort();
    expect(wave9a).toEqual(
      [
        'alerts.noise',
        'dashboard.ops.sla',
        'dashboard.ops.volume',
        'home.my_work',
        'home.team',
        'incidents.open',
        'shift.overview',
      ].sort(),
    );
    const existing = [
      'shift.brief',
      'shift.handoff',
      'ticket.workspace',
      'conversation.pane',
      'roster.planner',
      'reports.ceo.brief',
    ] as const;
    for (const key of existing) expect(INSIGHT_ELEMENTS[key].mode).toBe('R');
    const none = [
      'shift.notes',
      'kb',
      'admin.users',
      'admin.audit',
      'admin.golden',
      'admin.sla',
      'admin.rbac',
    ] as const;
    for (const key of none) expect(INSIGHT_ELEMENTS[key].mode).toBe('X');
    expect(NARRATED_INSIGHT_ELEMENTS).not.toContain('home.team');
    expect(NARRATED_INSIGHT_ELEMENTS).toContain('shift.overview');
  });

  it('keeps the ticket.read rule of incidents and the masked ref kinds', () => {
    expect(INSIGHT_ELEMENTS['incidents.open'].rule).toEqual({ all: ['ticket.read'] });
    expect(INSIGHT_MASKED_REF_KINDS).toEqual(['org', 'contact']);
  });
});

describe('period', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const days = INSIGHT_ELEMENTS['dashboard.ops.sla'].periods;
  it('accepts only the shapes of the spec', () => {
    expect(isInsightPeriodAllowed(days, 'd7', now)).toBe(true);
    expect(isInsightPeriodAllowed(days, 'd90', now)).toBe(true);
    expect(isInsightPeriodAllowed(days, 'd91', now)).toBe(false);
    expect(isInsightPeriodAllowed(days, 'd0', now)).toBe(false);
    expect(isInsightPeriodAllowed(days, 'now', now)).toBe(false);
    expect(isInsightPeriodAllowed(INSIGHT_ELEMENTS['incidents.open'].periods, 'now', now)).toBe(
      true,
    );
    expect(isInsightPeriodAllowed(INSIGHT_ELEMENTS.kb.periods, '-', now)).toBe(true);
    const shift = [{ kind: 'shift' }] as const;
    expect(isInsightPeriodAllowed(shift, 'shift:3f2b8c3e-8f0b-4a53-9f3b-1b2c3d4e5f60', now)).toBe(
      true,
    );
    expect(isInsightPeriodAllowed(shift, 'shift:nope', now)).toBe(false);
  });
  it('bounds an ISO week to the past 26 weeks', () => {
    const weekly = INSIGHT_ELEMENTS['reports.ceo.figures'].periods;
    expect(isInsightPeriodAllowed(weekly, 'w2026-45', now)).toBe(true);
    expect(isInsightPeriodAllowed(weekly, 'w2026-50', now)).toBe(false);
    expect(isInsightPeriodAllowed(weekly, 'w2025-30', now)).toBe(false);
    expect(isInsightPeriodAllowed(weekly, 'w2026-00', now)).toBe(false);
  });
});

describe('facts and claims', () => {
  const fact = {
    id: 'f1',
    kind: 'metric',
    value: 12,
    display: { th: '12 รายการ', en: '12 items' },
  };
  it('has no field for free text and rejects unknown ref kinds', () => {
    expect(insightFactSchema.safeParse(fact).success).toBe(true);
    expect(
      insightFactSchema.safeParse({ ...fact, display: { th: 'x'.repeat(201), en: 'x' } }).success,
    ).toBe(false);
    expect(
      insightFactSchema.safeParse({ ...fact, ref: { kind: 'ticket', id: 'T-1' } }).success,
    ).toBe(true);
    expect(insightFactSchema.safeParse({ ...fact, ref: { kind: 'email', id: 'a' } }).success).toBe(
      false,
    );
  });
  it('requires evidence on a stored claim', () => {
    expect(insightStoredClaimSchema.safeParse({ text: 'x', evidence: [] }).success).toBe(false);
    const ok = { text: 'x', evidence: [{ kind: 'intent', id: 'i', factId: 'f1' }] };
    expect(insightStoredClaimSchema.safeParse(ok).success).toBe(true);
  });
});

describe('templates', () => {
  it('has Thai and English with the same parameters', () => {
    for (const id of Object.keys(INSIGHT_TEMPLATES) as InsightTemplateId[]) {
      const th = [...INSIGHT_TEMPLATES[id].th.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const en = [...INSIGHT_TEMPLATES[id].en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(th, id).toEqual(en);
    }
  });
  it('renders by locale and throws on a missing parameter', () => {
    expect(renderInsightTemplate('delta_up', { label: 'backlog', percent: 18 }, 'en')).toBe(
      'backlog is up 18% on the 7-day average',
    );
    expect(renderInsightTemplate('delta_up', { label: 'backlog', percent: 18 }, 'th')).toBe(
      'backlog เพิ่มขึ้น 18% จากค่าเฉลี่ย 7 วัน',
    );
    expect(renderInsightTemplate('open_count', { count: 1234 }, 'en')).toBe('1,234 open');
    expect(() => renderInsightTemplate('delta_up', { label: 'x' }, 'en')).toThrow(/percent/);
    expect(insightTemplateParams('my_work_sla_risk').sort()).toEqual(['count', 'total']);
  });
  it('turns a template claim into a Claim whose uncited flag agrees with its evidence', () => {
    const claim = { templateId: 'no_change', params: {}, evidence: [] };
    expect(renderInsightTemplateClaim(claim, 'en')).toEqual({
      text: 'Nothing has changed that needs reporting',
      evidence: [],
      uncited: true,
    });
    expect(renderInsightTemplateClaim({ ...claim, templateId: 'unknown' }, 'en')).toBeNull();
  });
});

describe('states (AC-J17)', () => {
  it('has the exact copy for six states', () => {
    expect(INSIGHT_STATES).toEqual(['system', 'paused', 'fresh', 'stale', 'budget', 'none']);
    expect(INSIGHT_STATE_COPY.system).toEqual({ th: 'จากระบบ', en: 'From system' });
    expect(INSIGHT_STATE_COPY.paused.th).toBe('AI หยุดทำงาน — แสดงข้อมูลตรงจากระบบ');
    expect(INSIGHT_STATE_COPY.paused.en).toBe('AI paused — showing system data');
    expect(INSIGHT_STATE_COPY.stale).toEqual({
      th: 'สรุปก่อนข้อมูลล่าสุด',
      en: 'Summary predates latest data',
    });
    expect(INSIGHT_STATE_COPY.budget.th).toBe('สรุป AI พักชั่วคราว (ครบงบวันนี้)');
    expect(INSIGHT_STATE_COPY.budget.en).toBe('AI summaries paused (daily budget reached)');
    expect(INSIGHT_STATE_COPY.none.th).toBe('ยังไม่มีสรุป AI ล่าสุด — แสดงข้อมูลจากระบบ');
    expect(INSIGHT_STATE_COPY.none.en).toBe('No current AI summary — showing system data');
  });
  it('labels fresh with minutes under an hour and hours after', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const five = new Date('2026-11-05T09:55:00Z');
    const two = new Date('2026-11-05T07:30:00Z');
    expect(insightStateLabel('fresh', 'th', five, now)).toBe('AI · 5 นาทีที่แล้ว');
    expect(insightStateLabel('fresh', 'en', five, now)).toBe('AI · 5m ago');
    expect(insightStateLabel('fresh', 'th', two, now)).toBe('AI · 2 ชม.ที่แล้ว');
    expect(insightStateLabel('fresh', 'en', two, now)).toBe('AI · 2h ago');
    expect(insightStateLabel('budget', 'en')).toBe('AI summaries paused (daily budget reached)');
  });
  it('does not mix languages in any English label', () => {
    for (const state of INSIGHT_STATES) {
      expect(insightStateLabel(state, 'en', new Date(), new Date())).not.toMatch(/[฀-๿]/);
    }
  });
  it('picks the state in the order of section 9.3', () => {
    const now = new Date('2026-11-05T10:00:00Z');
    const live = { expiresAt: new Date('2026-11-05T12:00:00Z'), fingerprintMatches: true };
    const base = { mode: 'N' as const, paused: false, narration: live, budgetOpen: true, now };
    expect(selectInsightState({ ...base, mode: 'F' })).toBe('system');
    expect(selectInsightState({ ...base, maskedNoClaims: true })).toBe('system');
    expect(selectInsightState({ ...base, paused: true })).toBe('paused');
    expect(selectInsightState(base)).toBe('fresh');
    expect(selectInsightState({ ...base, budgetOpen: false })).toBe('fresh');
    expect(selectInsightState({ ...base, narration: { ...live, fingerprintMatches: false } })).toBe(
      'stale',
    );
    expect(selectInsightState({ ...base, narration: null, budgetOpen: false })).toBe('budget');
    expect(selectInsightState({ ...base, narration: null })).toBe('none');
    const old = { expiresAt: new Date('2026-11-05T09:00:00Z'), fingerprintMatches: true };
    expect(selectInsightState({ ...base, narration: old })).toBe('none');
  });
});

describe('numbersSubsetOfFacts', () => {
  const facts: InsightFact[] = [
    {
      id: 'backlog',
      kind: 'metric',
      value: 1234,
      display: { th: '1,234 รายการ', en: '1,234 items' },
    },
    { id: 'delta', kind: 'delta', value: -18.5, display: { th: '-18.5%', en: '-18.5%' } },
    { id: 'wait', kind: 'metric', value: 15, display: { th: '15 นาที', en: '15m' } },
    { id: 'state', kind: 'state', value: 'degraded', display: { th: 'ช้าลง', en: 'degraded' } },
  ];
  it('extracts Arabic and Thai digits, commas, decimals, percent and time units', () => {
    expect(extractInsightNumbers('๑,๒๓๔ รายการ')).toEqual(['1234']);
    expect(extractInsightNumbers('18.50% และ 2h, 15 นาที')).toEqual(['18.5', '2', '15']);
    expect(extractInsightNumbers('1,2')).toEqual(['1', '2']);
    expect(extractInsightNumbers('ไม่มีตัวเลข')).toEqual([]);
  });
  it('accepts numbers the facts have, in either script', () => {
    expect(numbersSubsetOfFacts('backlog 1,234 รายการ ลดลง 18.5% ใน 15 นาที', facts)).toEqual({
      ok: true,
      unmatched: [],
    });
    expect(numbersSubsetOfFacts('backlog ๑๒๓๔ ลดลง ๑๘.๕%', facts).ok).toBe(true);
    expect(numbersSubsetOfFacts('nothing numeric here', facts).ok).toBe(true);
  });
  it('rejects a number no fact has', () => {
    expect(numbersSubsetOfFacts('backlog is 1,243', facts)).toEqual({
      ok: false,
      unmatched: ['1243'],
    });
    expect(numbersSubsetOfFacts('up 19%', facts).unmatched).toEqual(['19']);
    expect(numbersSubsetOfFacts('about 3 items', []).ok).toBe(false);
  });
  it('does not match a digit substring of a larger number', () => {
    expect(numbersSubsetOfFacts('123 items', facts).ok).toBe(false);
    expect(numbersSubsetOfFacts('1 item', facts).ok).toBe(false);
  });
});
