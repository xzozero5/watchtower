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

  it('is plain: no image, no script, no tracking pixel, no style block', () => {
    const { html } = renderEmail(job());
    expect(html).not.toMatch(/<img|<script|<iframe|<link|<style|<video|<form|url\(/i);
    // The only addresses in it are the five rating links and the fallback link: nothing is fetched.
    const urls = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(urls).toHaveLength(6);
    expect(urls.every((url) => url.startsWith('https://desk.example.test/csat#token='))).toBe(true);
  });

  it('is an HTML email in the brand colors with inline CSS only', () => {
    const { html } = renderEmail(job());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('width=device-width');
    // Midnight Navy buttons, Warm Ivory text on them, Golden Beacon accent, Canvas Warm Cream background.
    for (const color of ['#0F172A', '#F7F0D4', '#F59E0B', '#F7F7ED']) expect(html).toContain(color);
    // The coral of the logo never colors a button (docs/brand/README.md, alert discipline).
    expect(html).not.toMatch(/#E5594A|#F67963/i);
    expect(html).toContain('Watchtower</td>');
    // One button per score, each a link with its number and word.
    for (const score of [1, 2, 3, 4, 5]) {
      expect(html).toContain(`;color:#FFFFFF;">${String(score)}</td>`);
    }
    for (const word of ['Very unhappy', 'Unhappy', 'Okay', 'Happy', 'Very happy']) {
      expect(html).toContain(`>${word}</span>`);
    }
  });

  it('has a plain-text part with the same links, in both languages', () => {
    for (const locale of ['en', 'th'] as const) {
      const message = renderEmail(job({ locale }));
      expect(message.text).not.toMatch(/<[a-z]/i);
      for (const score of [1, 2, 3, 4, 5]) {
        expect(message.text).toContain(`${URL_WITH_TOKEN}&score=${String(score)}`);
      }
    }
  });

  it('the Thai email is Thai in the HTML too, and escapes what it is given', () => {
    const { html } = renderEmail(job({ locale: 'th', ticketKey: 'OPS-<1>' }));
    expect(html).toContain('<html lang="th">');
    expect(html).toContain('พอใจมาก</span>');
    expect(html).toContain('OPS-&lt;1&gt;');
    expect(html).not.toContain('OPS-<1>');
  });
});
