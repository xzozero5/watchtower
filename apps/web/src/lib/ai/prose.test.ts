import { describe, expect, it } from 'vitest';

import { detectProseLang, humanizeKey, stripMarkdown } from './prose';

describe('stripMarkdown', () => {
  it('removes headings, emphasis, bullets and code marks but keeps the words', () => {
    expect(stripMarkdown('## Unlock an account\n\n**Wait** 15 minutes, then `reset` once.')).toBe(
      'Unlock an account Wait 15 minutes, then reset once.',
    );
    expect(stripMarkdown('- one\n- two\n1. three')).toBe('one two three');
    expect(stripMarkdown('_soft_ and __strong__ and ~~gone~~')).toBe('soft and strong and gone');
  });

  it('keeps a link label and drops its address, also for images', () => {
    expect(stripMarkdown('See [the guide](https://example.com/kb) now')).toBe('See the guide now');
    expect(stripMarkdown('![diagram](https://example.com/a.png) done')).toBe('diagram done');
  });

  it('drops raw HTML and script tags, so no markup is left', () => {
    const out = stripMarkdown('Hello <b>there</b><script>alert(1)</script> <img src=x onerror=y>');
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain('Hello there');
  });

  it('removes code fences and block quote marks, and unescapes', () => {
    expect(stripMarkdown('```sh\nrm cache\n```\n> note \\*literal\\*')).toBe(
      'rm cache note *literal*',
    );
  });

  it('leaves plain Thai text alone', () => {
    expect(stripMarkdown('บัญชีจะปลดล็อกเอง 15 นาที')).toBe('บัญชีจะปลดล็อกเอง 15 นาที');
  });
});

describe('detectProseLang', () => {
  it('tells Thai from English by script', () => {
    expect(detectProseLang('Reply from the guide')).toBe('en');
    expect(detectProseLang('ตอบลูกค้าตามคู่มือ')).toBe('th');
    expect(detectProseLang('ตอบ OPS-1 ตามคู่มือ KB')).toBe('th');
    expect(detectProseLang('')).toBe('en');
  });
});

describe('humanizeKey', () => {
  it('turns a key into words', () => {
    expect(humanizeKey('billing_report')).toBe('Billing report');
    expect(humanizeKey('login-issue')).toBe('Login issue');
    expect(humanizeKey('_')).toBe('_');
  });
});
