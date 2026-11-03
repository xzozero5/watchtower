import { join } from 'node:path';

import {
  DEFAULT_SHIFT_DEFINITIONS,
  DEFAULT_WEEKLY_HOURS,
  type BusinessCalendar,
} from '@watchtower/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_EXAMPLES_DIR } from '../common.js';
import { loadIntentDefinitions } from '../intents.js';
import { loadHolidayFiles, loadSlaPolicyFiles } from '../reference.js';
import { Rng } from './prng.js';
import { renderMail } from './email.js';
import { makeScreenshotPng } from './png.js';
import { INSERT_ORDER, planYear, type YearPlanFull } from './plan.js';
import type { Reference } from './types.js';

const NOW = new Date('2026-11-03T08:30:00.000Z'); // 15:30 in Bangkok, a Tuesday
const DAY_MS = 86_400_000;

async function buildReference(): Promise<Reference> {
  const [holidayFiles, slaFiles, intents] = await Promise.all([
    loadHolidayFiles(join(DEFAULT_EXAMPLES_DIR, 'calendars')),
    loadSlaPolicyFiles(join(DEFAULT_EXAMPLES_DIR, 'sla')),
    loadIntentDefinitions(join(DEFAULT_EXAMPLES_DIR, 'intents')),
  ]);
  const holidays = holidayFiles.flatMap((f) => f.holidays.map((h) => h.date));
  const calendar: BusinessCalendar = {
    timezone: 'Asia/Bangkok',
    hours: DEFAULT_WEEKLY_HOURS,
    holidays,
  };
  const policies = Object.fromEntries(
    slaFiles
      .flatMap((f) => f.policies)
      .map((p) => [p.tier, { id: `policy-${p.tier}`, targets: p.targets, calendar }]),
  ) as Reference['policies'];
  const ids = new Rng(7);
  return {
    policies,
    intents: intents.map((i) => ({
      id: ids.uuid(),
      key: i.key,
      defaultPriority: i.defaultPriority,
      autonomyStage: 2,
    })),
    queues: { Support: ids.uuid(), Integrations: ids.uuid(), Billing: ids.uuid() },
    channelAccounts: { gmail: ids.uuid(), line: ids.uuid(), portal: ids.uuid() },
    shifts: DEFAULT_SHIFT_DEFINITIONS.map((s) => ({ id: ids.uuid(), ...s })),
    holidays: new Set(holidays),
    ticketKeyPrefix: 'OPS',
  };
}

let reference: Reference;
let plan: YearPlanFull;
let smallA: YearPlanFull;
let smallB: YearPlanFull;

beforeAll(async () => {
  reference = await buildReference();
  const input = {
    reference,
    now: NOW,
    firstTicketNumber: 100,
    escalationPolicyId: null,
    attachments: true,
  };
  plan = planYear(input);
  const small = { ...input, ticketTarget: 300 };
  smallA = planYear(small);
  smallB = planYear(small);
}, 120_000);

const rows = (name: string) => plan.tables.get(name) ?? [];
const n = (name: string): number => plan.summary[name] ?? 0;

describe('one-year scenario plan', () => {
  it('is deterministic: the same inputs give the same rows', () => {
    const digest = (p: YearPlanFull) =>
      JSON.stringify(
        [...p.tables].map(([name, list]) => [name, list.length, list.slice(0, 3), list.slice(-3)]),
      );
    expect(digest(smallB)).toBe(digest(smallA));
    expect(smallB.summary).toEqual(smallA.summary);
    expect(digest(smallA)).not.toBe(digest(plan));
  });

  it('has counts in the expected ranges', () => {
    const s = {
      ticket: n('ticket'),
      organization: n('organization'),
      kb_article: n('kb_article'),
      incident: n('incident'),
      message: n('message'),
    };
    expect(s.ticket).toBeGreaterThanOrEqual(3000);
    expect(s.ticket).toBeLessThanOrEqual(5000);
    expect(s.organization).toBeGreaterThanOrEqual(25);
    expect(s.organization).toBeLessThanOrEqual(40);
    expect(s.kb_article).toBeGreaterThanOrEqual(80);
    expect(s.kb_article).toBeLessThanOrEqual(150);
    expect(s.incident).toBeGreaterThanOrEqual(15);
    expect(s.incident).toBeLessThanOrEqual(25);
    expect(s.message).toBeGreaterThan(s.ticket * 2);
    expect(rows('users').filter((u) => u.role !== 'client')).toHaveLength(12);
  });

  it('keeps every timestamp inside the year and never in the future', () => {
    const start = NOW.getTime() - 366 * DAY_MS;
    for (const name of [
      'ticket',
      'message',
      'ticket_event',
      'audit_log',
      'ai_run',
      'csat_survey',
      'alert',
      'incident',
      'incident_timeline',
    ]) {
      for (const row of rows(name)) {
        const at = (row.created_at ?? row.first_seen_at ?? row.started_at) as Date;
        expect(at.getTime(), name).toBeGreaterThanOrEqual(start);
        expect(at.getTime(), name).toBeLessThanOrEqual(NOW.getTime());
      }
    }
  });

  it('writes every table with the same columns in every row', () => {
    for (const name of INSERT_ORDER) {
      const list = rows(name);
      if (list.length === 0) continue;
      const keys = Object.keys(list[0] ?? {})
        .toSorted()
        .join(',');
      const odd = list.find((r) => Object.keys(r).toSorted().join(',') !== keys);
      expect(odd, `${name} has rows with different columns`).toBeUndefined();
    }
  });

  it('has unique ids and ticket numbers', () => {
    for (const name of ['ticket', 'message', 'kb_article', 'alert', 'incident', 'users']) {
      const ids = rows(name).map((r) => r.id);
      expect(new Set(ids).size, name).toBe(ids.length);
    }
    const numbers = rows('ticket').map((r) => r.number as number);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(Math.min(...numbers)).toBe(100);
  });

  it('mixes channels with email the most common', () => {
    const counts = new Map<string, number>();
    for (const t of rows('ticket'))
      counts.set(t.channel as string, (counts.get(t.channel as string) ?? 0) + 1);
    const email = counts.get('gmail') ?? 0;
    for (const [channel, n] of counts) if (channel !== 'gmail') expect(email).toBeGreaterThan(n);
    expect(counts.get('line') ?? 0).toBeGreaterThan(50);
    expect(counts.get('portal') ?? 0).toBeGreaterThan(200);
    expect((counts.get('phone') ?? 0) + (counts.get('chat') ?? 0)).toBeGreaterThan(20);
  });

  it('keeps most SLAs and breaches some', () => {
    const closed = rows('ticket').filter((t) => t.first_responded_at && t.first_response_due_at);
    const late = closed.filter(
      (t) => (t.first_responded_at as Date).getTime() > (t.first_response_due_at as Date).getTime(),
    );
    const rate = late.length / closed.length;
    expect(rate).toBeGreaterThan(0.02);
    expect(rate).toBeLessThan(0.18);
    const resolved = rows('ticket').filter((t) => t.resolved_at && t.resolution_due_at);
    const resLate = resolved.filter(
      (t) => (t.resolved_at as Date).getTime() > (t.resolution_due_at as Date).getTime(),
    );
    expect(resLate.length / resolved.length).toBeLessThan(0.2);
  });

  it('leaves live work in the last two weeks and finished work before', () => {
    const open = ['new', 'triage', 'open', 'waiting_on_customer', 'waiting_on_dev'];
    const recent = rows('ticket').filter(
      (t) => (t.created_at as Date).getTime() > NOW.getTime() - 14 * DAY_MS,
    );
    const live = recent.filter((t) => open.includes(t.status as string));
    expect(live.length).toBeGreaterThan(25);
    const statuses = new Set(live.map((t) => t.status));
    expect(statuses.has('open')).toBe(true);
    expect(statuses.has('waiting_on_customer')).toBe(true);
    const old = rows('ticket').filter(
      (t) => (t.created_at as Date).getTime() < NOW.getTime() - 60 * DAY_MS,
    );
    const stillOpen = old.filter((t) => open.includes(t.status as string));
    expect(stillOpen.length / old.length).toBeLessThan(0.02);
  });

  it('has weekday peaks and weekend troughs', () => {
    const byDay = [0, 0, 0, 0, 0, 0, 0];
    for (const t of rows('ticket')) {
      const local = new Date((t.created_at as Date).getTime() + 7 * 3600_000);
      byDay[local.getUTCDay()] = (byDay[local.getUTCDay()] ?? 0) + 1;
    }
    const weekday =
      (byDay[1] ?? 0) + (byDay[2] ?? 0) + (byDay[3] ?? 0) + (byDay[4] ?? 0) + (byDay[5] ?? 0);
    expect(weekday / ((byDay[0] ?? 1) + (byDay[6] ?? 1))).toBeGreaterThan(3);
  });

  it('writes Gmail-like HTML for email messages and no dangling image references', () => {
    const attachmentsKeys = new Set(plan.files.map((f) => f.objectKey));
    const email = rows('message').filter((m) => m.body_html);
    expect(email.length).toBeGreaterThan(5000);
    let quoted = 0;
    let signature = 0;
    let tables = 0;
    let inline = 0;
    for (const m of email) {
      const html = m.body_html as string;
      if (html.includes('gmail_quote') || html.includes('MsoNormal'))
        quoted += html.includes('wrote:') || html.includes('เขียนว่า') ? 1 : 0;
      if (html.includes('gmail_signature') || html.includes('Tech Ops')) signature += 1;
      if (html.includes('<table')) tables += 1;
      if (html.includes('src="cid:')) {
        inline += 1;
        const atts = m.attachments as { contentId: string | null; objectKey: string }[];
        for (const match of html.matchAll(/src="cid:([^"]+)"/g)) {
          expect(
            atts.some((a) => a.contentId === match[1] && attachmentsKeys.has(a.objectKey)),
          ).toBe(true);
        }
      }
      expect(typeof m.body_text).toBe('string');
    }
    expect(quoted).toBeGreaterThan(500);
    expect(signature).toBeGreaterThan(email.length / 2);
    expect(tables).toBeGreaterThan(20);
    expect(inline).toBeGreaterThan(5);
  });

  it('writes no attachment rows when the files cannot be stored', () => {
    const none = planYear({
      reference,
      now: NOW,
      firstTicketNumber: 1,
      escalationPolicyId: null,
      attachments: false,
      ticketTarget: 300,
    });
    expect(none.files).toHaveLength(0);
    expect(
      none.tables.get('message')?.every((m) => (m.attachments as unknown[]).length === 0),
    ).toBe(true);
    expect(
      none.tables
        .get('message')
        ?.some((m) => (typeof m.body_html === 'string' ? m.body_html : '').includes('cid:')),
    ).toBe(false);
  });

  it('keeps AI at stage 2 with plausible approve / edit / reject ratios', () => {
    const drafts = rows('ai_draft');
    expect(drafts.length).toBeGreaterThan(1500);
    const resolved = drafts.filter((d) => d.disposition);
    const share = (name: string) =>
      resolved.filter((d) => d.disposition === name).length / resolved.length;
    expect(share('approved')).toBeGreaterThan(0.3);
    expect(share('approved')).toBeLessThan(0.65);
    expect(share('edited')).toBeGreaterThan(0.2);
    expect(share('rejected')).toBeGreaterThan(0.08);
    expect(share('rejected')).toBeLessThan(0.3);
    // N3: nothing is sent by the AI itself; every sent draft names the person who approved it.
    for (const d of drafts.filter((x) => x.status === 'sent')) expect(d.approved_by).toBeTruthy();
    expect(rows('ai_run').every((r) => r.provider === 'mock')).toBe(true);
    expect(
      rows('ticket').every((t) => t.ai_handled === false && t.autonomy_stage_at_creation === 2),
    ).toBe(true);
  });

  it('answers about 30% of CSAT surveys', () => {
    const sent = rows('csat_survey').filter((s) =>
      ['sent', 'answered', 'expired'].includes(s.status as string),
    );
    const answered = sent.filter((s) => s.status === 'answered');
    expect(answered.length / sent.length).toBeGreaterThan(0.24);
    expect(answered.length / sent.length).toBeLessThan(0.36);
  });

  it('is organization-neutral: reserved domains, no phone or id numbers', () => {
    const text = JSON.stringify(
      [...plan.tables].filter(([name]) => name !== 'outbox').map(([, list]) => list),
    );
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    expect(emails.length).toBeGreaterThan(1000);
    for (const email of emails) {
      expect(email, email).toMatch(/@([a-z0-9-]+\.)*example\.(com|org|net)$/i);
    }
    expect(text).not.toMatch(/(?<![0-9a-f-])\d{3}-\d{3}-\d{4}(?![0-9])/);
    expect(text).not.toMatch(/\b0\d{9}\b/);
    expect(text).not.toMatch(/\b\d{13}\b/);
    expect(text).not.toMatch(/password\s*[:=]/i);
  });

  it('gives hosts that need them: services, runbooks, deploys, status posts', () => {
    expect(rows('service').length).toBe(8);
    expect(rows('deploy').length).toBeGreaterThan(100);
    expect(rows('status_post').length).toBeGreaterThan(20);
    expect(rows('handoff').length).toBeGreaterThan(500);
    expect(rows('handoff_item').length).toBeGreaterThan(rows('handoff').length);
    expect(rows('shift_note_read').length).toBeGreaterThan(100);
    expect(rows('notification').length).toBeGreaterThan(50);
    expect(rows('kb_article').filter((a) => a.status === 'draft').length).toBeGreaterThan(0);
    expect(rows('kb_article').filter((a) => a.status === 'deprecated').length).toBeGreaterThan(0);
    expect(rows('kb_article_version').length).toBeGreaterThan(rows('kb_article').length);
  });
});

describe('building blocks', () => {
  it('draws the same numbers for the same seed', () => {
    const a = new Rng('x');
    const b = new Rng('x');
    expect([a.next(), a.int(1, 9), a.uuid()]).toEqual([b.next(), b.int(1, 9), b.uuid()]);
  });

  it('renders an email with quote, table and signature in both bodies', () => {
    const mail = renderMail({
      style: 'gmail',
      lang: 'en',
      paragraphs: ['Hello <team>', 'req_0123abcd failed'],
      table: { headers: ['a', 'b'], rows: [['1', '2']] },
      signature: ['Name', 'Title'],
      quote: {
        author: { name: 'Agent', address: 'agent@ops.example.com' },
        at: NOW,
        text: 'earlier text',
      },
    });
    expect(mail.html).toContain('gmail_quote');
    expect(mail.html).toContain('&lt;team&gt;');
    expect(mail.html).toContain('<table');
    expect(mail.text).toContain('> earlier text');
    expect(mail.text).toMatch(
      /On \w{3}, 3 Nov 2026 at 15:30, Agent <agent@ops.example.com> wrote:/,
    );
  });

  it('makes a valid small PNG', () => {
    const png = makeScreenshotPng(2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.length).toBeLessThan(20_000);
    expect(makeScreenshotPng(2).equals(png)).toBe(true);
  });
});
