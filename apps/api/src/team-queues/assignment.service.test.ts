import { describe, expect, it } from 'vitest';

import { pickNextMember } from './assignment.service.js';

describe('pickNextMember', () => {
  const ids = ['11', '22', '33'];

  it('starts with the first member when nobody was assigned yet', () => {
    expect(pickNextMember(ids, null)).toBe('11');
  });

  it('moves to the member after the last one and wraps round', () => {
    expect(pickNextMember(ids, '11')).toBe('22');
    expect(pickNextMember(ids, '22')).toBe('33');
    expect(pickNextMember(ids, '33')).toBe('11');
  });

  it('continues from where a removed member would have been', () => {
    expect(pickNextMember(['11', '33'], '22')).toBe('33');
    expect(pickNextMember(['11', '22'], '33')).toBe('11');
  });

  it('has nobody to pick from an empty queue', () => {
    expect(pickNextMember([], null)).toBeNull();
    expect(pickNextMember([], '22')).toBeNull();
  });

  it('keeps picking the only member', () => {
    expect(pickNextMember(['44'], '44')).toBe('44');
  });
});
