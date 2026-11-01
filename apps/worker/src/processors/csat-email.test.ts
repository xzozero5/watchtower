import { describe, expect, it } from 'vitest';

import { renderEmail } from './email.js';

const URL_WITH_TOKEN = 'https://desk.example.test/csat#token=wtc1.abc.def.ghi';

const job = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'csat_survey',
    to: 'nok@example.test',
    locale: 'en',
    ticketKey: 'OPS-12',
    surveyUrl: URL_WITH_TOKEN,
    reminder: false,
    ...overrides,
  }) as const;

describe('the CSAT survey email', () => {
  it('has five rating links 1 to 5 that append the score to the fragment', () => {
    const message = renderEmail(job());
    expect(message.to).toBe('nok@example.test');
    expect(message.subject).toBe('How did we do on OPS-12?');
    for (const score of [1, 2, 3, 4, 5]) {
      expect(message.text).toContain(`${URL_WITH_TOKEN}&score=${String(score)}`);
      expect(message.html).toContain(`href="${URL_WITH_TOKEN}&amp;score=${String(score)}"`);
    }
  });

  it('is written in Thai for a Thai contact', () => {
    const message = renderEmail(job({ locale: 'th' }));
    expect(message.subject).toBe('เราให้บริการ OPS-12 เป็นอย่างไรบ้าง');
    expect(message.text).toContain('1 - ไม่พอใจมาก');
    expect(message.text).toContain('5 - พอใจมาก');
    expect(message.text).not.toContain('How did we do');
  });

  it('the reminder says so, in both languages, and has the same links', () => {
    const first = renderEmail(job());
    const reminder = renderEmail(job({ reminder: true }));
    expect(reminder.text.startsWith('A reminder')).toBe(true);
    expect(reminder.text).toContain(`${URL_WITH_TOKEN}&score=3`);
    expect(reminder.subject).toBe(first.subject);
    expect(renderEmail(job({ reminder: true, locale: 'th' })).text.startsWith('ขอเตือน')).toBe(
      true,
    );
  });

  it('is plain: no image, no script, no tracking pixel', () => {
    const { html } = renderEmail(job());
    expect(html).not.toMatch(/<img|<script|<iframe|<link|<style/i);
  });
});
