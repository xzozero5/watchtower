import {
  emailJobSchema,
  weeklyBriefEmailParts,
  type Claim,
  type EmailJob,
} from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { renderEmail } from './email.js';

const job = (over: Partial<Extract<EmailJob, { kind: 'weekly_brief' }>> = {}): EmailJob =>
  emailJobSchema.parse({
    kind: 'weekly_brief',
    to: 'ceo@example.test',
    locale: 'en',
    periodFrom: '2026-11-03T00:00:00.000Z',
    periodTo: '2026-11-09T03:00:00.000Z',
    pageUrl: 'http://localhost:3000/dashboard/ceo',
    summary: ['SLA compliance: 90% [SLA compliance]', 'A line a person wrote (no evidence)'],
    rootCauses: [
      {
        title: 'Sign-in loop',
        text: 'Nine tickets [OPS-12, OPS-15]',
        ask: 'Review the session cookie',
      },
      { title: 'Billing', text: 'Two tickets [OPS-20]', ask: null },
    ],
    decisions: ['INC-3 is still open [INC-3]'],
    ...over,
  });

const ticket = { kind: 'ticket', label: 'OPS-12', href: '/?ticket=OPS-12' } as const;
const intent = { kind: 'data', label: 'intent: Password reset' } as const;
const person = { kind: 'person', label: 'Somchai Jaidee' } as const;
const cited = (text: string, ...evidence: Claim['evidence']): Claim => ({
  text,
  evidence,
  uncited: false,
});

describe('weekly brief email', () => {
  it('renders the sections, the evidence names and the link, in English', () => {
    const message = renderEmail(job());
    expect(message.to).toBe('ceo@example.test');
    expect(message.subject).toBe('Weekly brief 2026-11-03 to 2026-11-09');
    expect(message.text).toContain('This week');
    expect(message.text).toContain('- SLA compliance: 90% [SLA compliance]');
    expect(message.text).toContain('- A line a person wrote (no evidence)');
    expect(message.text).toContain(
      'Sign-in loop: Nine tickets [OPS-12, OPS-15] (Suggested ask: Review the session cookie)',
    );
    expect(message.text).toContain('- Billing: Two tickets [OPS-20]');
    expect(message.text).toContain('Decisions needed');
    expect(message.text).toContain('http://localhost:3000/dashboard/ceo');
  });

  it('renders Thai when the brief is Thai, and omits an empty section', () => {
    const message = renderEmail(job({ locale: 'th', decisions: [] }));
    expect(message.subject).toBe('สรุปรายสัปดาห์ 2026-11-03 ถึง 2026-11-09');
    expect(message.text).toContain('สาเหตุหลัก');
    expect(message.text).not.toContain('เรื่องที่ต้องตัดสินใจ\n');
  });

  it('escapes what a person typed in the HTML part and loads nothing from outside', () => {
    const message = renderEmail(job({ summary: ['<script>alert(1)</script> & more'] }));
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more');
    expect(message.html).not.toMatch(/<img|<link|src=|@import/);
  });

  it('holds no name or subject that a brief restored, only figures, keys and intent names (T-305f)', () => {
    const parts = weeklyBriefEmailParts(
      {
        summary: [cited('Somchai Jaidee of Acme Co: refund for invoice 77.', person, ticket)],
        rootCauses: [
          {
            title: 'Acme Co cannot sign in',
            claims: [cited('Somchai Jaidee: login loop.', intent, ticket, person)],
            ask: 'Call Somchai Jaidee',
          },
        ],
        decisions: [cited('Refund Acme Co?', ticket)],
      },
      'en',
      ['SLA compliance: 90% (period before 85%).'],
    );
    const message = renderEmail(job({ ...parts, pageUrl: 'http://localhost:3000/dashboard/ceo' }));
    const everything = [message.subject, message.text, message.html].join('\n');
    for (const leak of ['Somchai', 'Jaidee', 'Acme', 'refund', 'invoice', 'login loop', 'Call ']) {
      expect(everything).not.toContain(leak);
    }
    expect(message.text).toContain('SLA compliance: 90%');
    expect(message.text).toContain('Password reset: [OPS-12]');
    expect(message.text).toContain('Needs a decision: [OPS-12]');
    expect(message.text).toContain('http://localhost:3000/dashboard/ceo');
  });
});
