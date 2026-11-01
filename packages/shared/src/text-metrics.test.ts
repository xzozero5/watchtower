import { describe, expect, it } from 'vitest';

import { detectLanguage, editDistance, MAX_EDIT_WORDS } from './text-metrics.js';

describe('detectLanguage', () => {
  it('tells Thai from English and defaults to English', () => {
    expect(detectLanguage('สวัสดีครับ ช่วยตรวจสอบหน่อย')).toBe('th');
    expect(detectLanguage('Hello, please check my account')).toBe('en');
    expect(detectLanguage('Please check the รหัสผ่าน reset page for my account')).toBe('en');
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('1234 !!!')).toBe('en');
  });
});

describe('editDistance', () => {
  it('is 0 for the same words and ignores case and punctuation', () => {
    expect(editDistance('Hello there, friend.', 'hello there friend')).toBe(0);
    expect(editDistance('', '')).toBe(0);
  });

  it('is 1 when nothing is shared or one side is empty', () => {
    expect(editDistance('alpha beta', 'gamma delta')).toBe(1);
    expect(editDistance('alpha', '')).toBe(1);
    expect(editDistance('', 'alpha')).toBe(1);
  });

  it('counts one changed word out of four as a quarter', () => {
    expect(editDistance('we fixed the bug', 'we fixed the issue')).toBe(0.25);
  });

  it('is symmetric and stays between 0 and 1', () => {
    const a = 'please reset your password and sign in again';
    const b = 'reset the password then log in';
    expect(editDistance(a, b)).toBe(editDistance(b, a));
    expect(editDistance(a, b)).toBeGreaterThan(0);
    expect(editDistance(a, b)).toBeLessThan(1);
  });

  it('measures Thai by words', () => {
    expect(editDistance('ขอบคุณที่แจ้งปัญหา', 'ขอบคุณที่แจ้งปัญหา')).toBe(0);
    expect(editDistance('ขอบคุณที่แจ้งปัญหา', 'สวัสดีครับ')).toBeGreaterThan(0.5);
  });

  it('bounds the work for a very long text', () => {
    const long = Array.from({ length: MAX_EDIT_WORDS * 2 }, (_, index) => `w${String(index)}`).join(
      ' ',
    );
    const started = Date.now();
    expect(editDistance(long, `${long} extra`)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
