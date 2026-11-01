import { beforeEach, describe, expect, it } from 'vitest';

import { claimSurveyLink, forgetSurveyLink, parseSurveyFragment } from './survey-link';

// A made-up value in the shape of a real one. Not a credential.
const SAMPLE = 'wtc1.abcdef.xyz.c2FtcGxl';

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/csat');
});

describe('parseSurveyFragment', () => {
  it('reads the token and the rating', () => {
    expect(parseSurveyFragment(`#token=${SAMPLE}&score=3`)).toEqual({ token: SAMPLE, score: 3 });
  });

  it('accepts a link without a rating', () => {
    expect(parseSurveyFragment(`#token=${SAMPLE}`)).toEqual({ token: SAMPLE, score: null });
  });

  it.each(['0', '6', 'x', '', '2.5', '10'])('ignores a rating of %j', (score) => {
    expect(parseSurveyFragment(`#token=${SAMPLE}&score=${score}`)?.score).toBeNull();
  });

  it.each([
    '',
    '#',
    '#score=3',
    '#token=',
    `#token=${'a'.repeat(513)}`,
    '#token=a%20b',
    '#token=a%00b',
  ])('has no link in %j', (hash) => {
    expect(parseSurveyFragment(hash)).toBeNull();
  });
});

describe('claimSurveyLink', () => {
  it('takes the link out of the address bar and keeps it for this tab', () => {
    window.history.replaceState(null, '', `/csat#token=${SAMPLE}&score=5`);
    expect(claimSurveyLink()).toEqual({ token: SAMPLE, score: 5 });
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(SAMPLE);
    // A reload has no fragment but finds it again.
    expect(claimSurveyLink()).toEqual({ token: SAMPLE, score: 5 });
  });

  it('a fresh link wins over what the tab holds', () => {
    window.history.replaceState(null, '', `/csat#token=${SAMPLE}`);
    claimSurveyLink();
    window.history.replaceState(null, '', '/csat#token=other.token.value&score=1');
    expect(claimSurveyLink()).toEqual({ token: 'other.token.value', score: 1 });
  });

  it('forgets the link on request', () => {
    window.history.replaceState(null, '', `/csat#token=${SAMPLE}`);
    claimSurveyLink();
    forgetSurveyLink();
    expect(claimSurveyLink()).toBeNull();
  });

  it('returns null for a tab with nothing, and ignores damaged storage', () => {
    expect(claimSurveyLink()).toBeNull();
    sessionStorage.setItem('wt-csat-link', '{not json');
    expect(claimSurveyLink()).toBeNull();
    sessionStorage.setItem('wt-csat-link', JSON.stringify({ token: 'has space', score: 3 }));
    expect(claimSurveyLink()).toBeNull();
  });

  it('strips an unusable fragment too, so nothing odd stays in the address bar', () => {
    window.history.replaceState(null, '', '/csat#garbage');
    expect(claimSurveyLink()).toBeNull();
    expect(window.location.hash).toBe('');
  });
});
