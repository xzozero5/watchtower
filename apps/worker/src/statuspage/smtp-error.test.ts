import { describe, expect, it } from 'vitest';

import { classifySmtpError } from './smtp-error.js';

const smtp = (fields: Record<string, unknown>): Error => Object.assign(new Error('smtp'), fields);

describe('classifySmtpError (T-125a)', () => {
  it('535 and EAUTH are our login, not the reader: auth', () => {
    expect(classifySmtpError(smtp({ responseCode: 535 }))).toBe('auth');
    expect(classifySmtpError(smtp({ code: 'EAUTH', responseCode: 535 }))).toBe('auth');
    expect(classifySmtpError(smtp({ code: 'EAUTH' }))).toBe('auth');
    expect(classifySmtpError(smtp({ responseCode: 534 }))).toBe('auth');
    expect(classifySmtpError(smtp({ responseCode: 530 }))).toBe('auth');
  });

  it('451 and the rest of 4xx are transient, even when nodemailer reports them as EENVELOPE', () => {
    expect(classifySmtpError(smtp({ responseCode: 451 }))).toBe('transient');
    expect(classifySmtpError(smtp({ code: 'EENVELOPE', responseCode: 451 }))).toBe('transient');
    expect(classifySmtpError(smtp({ responseCode: 421 }))).toBe('transient');
  });

  it('other 5xx and an envelope without a reply are permanent', () => {
    expect(classifySmtpError(smtp({ responseCode: 550 }))).toBe('permanent');
    expect(classifySmtpError(smtp({ code: 'EENVELOPE', responseCode: 553 }))).toBe('permanent');
    expect(classifySmtpError(smtp({ code: 'EENVELOPE' }))).toBe('permanent');
  });

  it('no reply at all (reset, timeout, a non-error) is transient', () => {
    expect(classifySmtpError(smtp({ code: 'ECONNRESET' }))).toBe('transient');
    expect(classifySmtpError(new Error('boom'))).toBe('transient');
    expect(classifySmtpError('boom')).toBe('transient');
    expect(classifySmtpError(null)).toBe('transient');
  });
});
