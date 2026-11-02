import { describe, expect, it } from 'vitest';

import {
  MASKED_TEXT_UNAVAILABLE,
  createMaskingSession,
  maskName,
  maskPhone,
} from './pii-masker.js';

describe('the masks', () => {
  it('keeps the first letter of a name and the last two digits of a phone', () => {
    expect(maskName('Somchai Demo')).toBe('S*** D***');
    expect(maskName('tanawat.secretlocal')).toBe('t***');
    expect(maskName('')).toBe('***');
    expect(maskName(null)).toBeNull();
    expect(maskPhone('+66 81 234 5678')).toBe('***78');
    expect(maskPhone(null)).toBeNull();
  });

  it('puts a name the dictionary knows, an address and a bare phone number behind placeholders', () => {
    const session = createMaskingSession('t', ['Somchai Demo']);
    const out = session.text('Somchai Demo wrote from a%40corp.example, 66812345678');
    expect(out).not.toMatch(/Somchai|corp|66812345678/);
    expect(out).toMatch(/\[NAME_\d+\].*\[EMAIL_\d+\].*\[PHONE_\d+\]/);
  });

  it('shows a notice instead of text when the list of names is not complete', () => {
    const session = createMaskingSession('t', ['Somchai Demo'], false);
    expect(session.text('anything at all')).toBe(MASKED_TEXT_UNAVAILABLE);
    expect(session.textOrNull(null)).toBeNull();
    // A name field is still reduced to initials: that needs no dictionary.
    expect(session.name('Somchai Demo')).toBe('S*** D***');
  });
});
