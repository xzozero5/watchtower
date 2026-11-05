import { describe, expect, it } from 'vitest';

import { createRedactor } from '../redaction/redactor.js';
import { classifyFollowUp, type FollowUp } from './follow-up.js';

const redact = (text: string) => createRedactor().session({ scope: 'follow-up' }).redact(text);

const cases: readonly (readonly [string, FollowUp])[] = [
  // confirm
  ['It works now, thanks!', 'confirm'],
  ['All good, the problem is gone', 'confirm'],
  ['I can log in again, fixed', 'confirm'],
  ['Issue resolved. Thank you', 'confirm'],
  ['ใช้งานได้แล้วครับ ขอบคุณ', 'confirm'],
  ['หายแล้วค่ะ', 'confirm'],
  ['เข้าได้แล้ว เรียบร้อย', 'confirm'],
  ['ไม่มีปัญหาแล้วครับ', 'confirm'],
  // deny
  ['Still not working', 'deny'],
  ["it doesn't work", 'deny'],
  ['It does not work for me', 'deny'],
  ['I still get the same error', 'deny'],
  ['Please reopen this ticket', 'deny'],
  ['The problem persists, no luck', 'deny'],
  ['ยังไม่หายเลยครับ', 'deny'],
  ['เข้าไม่ได้เหมือนเดิม', 'deny'],
  ['ขอเปิดเรื่องใหม่', 'deny'],
  ['ใช้ไม่ได้ค่ะ', 'deny'],
  // negated confirm
  ['Not fixed yet', 'deny'],
  ["It isn't resolved", 'deny'],
  ['It is not working now', 'deny'],
  ['ยังไม่ได้ครับ', 'deny'],
  ['ยังไม่เรียบร้อย', 'deny'],
  ['Fixed? No, it still fails. Works only once', 'deny'],
  // ambiguous
  ['Thanks', 'ambiguous'],
  ['ขอบคุณครับ', 'ambiguous'],
  ['ok', 'ambiguous'],
  ['I will try and tell you', 'ambiguous'],
  ['Is it working now?', 'ambiguous'],
  ['ใช้ได้แล้วไหมครับ', 'ambiguous'],
  ['ยังไงก็ขอบคุณครับ', 'ambiguous'],
  ['', 'ambiguous'],
];

describe('classifyFollowUp', () => {
  it.each(cases)('%j is %s', (text, expected) => {
    expect(classifyFollowUp(redact(text))).toBe(expected);
  });

  it('reads fullwidth and curly-apostrophe spellings', () => {
    expect(classifyFollowUp(redact('It doesn’t work'))).toBe('deny');
    expect(classifyFollowUp(redact('ＳＴＩＬＬ ＮＯＴ ＷＯＲＫＩＮＧ'))).toBe('deny');
  });
});
