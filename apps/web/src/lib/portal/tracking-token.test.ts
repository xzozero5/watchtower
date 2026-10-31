import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimedToken,
  claimIntoStore,
  claimTrackingToken,
  dropFromStore,
  forgetTrackingToken,
  parseFragmentToken,
  resetClaimedTokens,
  stripFragment,
} from './tracking-token';

// A made-up value in the shape of the real thing (URL-safe characters). Not a credential.
const SAMPLE = 'Zm9vYmFyLWV4YW1wbGUtb25seQ';

function go(path: string) {
  window.history.replaceState(null, '', path);
}

beforeEach(() => {
  sessionStorage.clear();
  resetClaimedTokens();
});
afterEach(() => {
  sessionStorage.clear();
  go('/');
});

describe('parseFragmentToken', () => {
  it('reads #token=...', () => {
    expect(parseFragmentToken(`#token=${SAMPLE}`)).toBe(SAMPLE);
    expect(parseFragmentToken(`token=${SAMPLE}`)).toBe(SAMPLE);
    expect(parseFragmentToken(`#a=1&token=${SAMPLE}`)).toBe(SAMPLE);
  });

  it('returns null when there is none, it is empty, too long or has odd characters', () => {
    expect(parseFragmentToken('')).toBeNull();
    expect(parseFragmentToken('#')).toBeNull();
    expect(parseFragmentToken('#other=1')).toBeNull();
    expect(parseFragmentToken('#token=')).toBeNull();
    expect(parseFragmentToken(`#token=${'a'.repeat(513)}`)).toBeNull();
    expect(parseFragmentToken('#token=has%20space')).toBeNull();
    expect(parseFragmentToken('#token=%3Cscript%3E%00')).toBeNull();
  });
});

describe('stripFragment', () => {
  it('removes the fragment, keeps path and query, and adds no history entry', () => {
    go(`/portal/tickets/OPS-12?lang=th#token=${SAMPLE}`);
    const before = window.history.length;
    stripFragment(window);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname + window.location.search).toBe(
      '/portal/tickets/OPS-12?lang=th',
    );
    expect(window.location.href).not.toContain(SAMPLE);
    expect(window.history.length).toBe(before);
  });
});

describe('claimTrackingToken', () => {
  it('takes the value from the fragment, removes it from the address bar and keeps it for the tab', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    expect(claimTrackingToken('OPS-12')).toBe(SAMPLE);
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(SAMPLE);
    // A reload (no fragment any more) still has it: sessionStorage of this tab.
    expect(claimTrackingToken('OPS-12')).toBe(SAMPLE);
    expect(sessionStorage.getItem('wt-portal-token:OPS-12')).toBe(SAMPLE);
  });

  it('keeps tickets apart', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    claimTrackingToken('OPS-12');
    expect(claimTrackingToken('OPS-13')).toBeNull();
  });

  it('returns null for a tab that has none, and strips an unusable fragment anyway', () => {
    go('/portal/tickets/OPS-12#token=has%20space');
    expect(claimTrackingToken('OPS-12')).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('does not rely on local storage or cookies', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    claimTrackingToken('OPS-12');
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('works in memory when storage is blocked', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    const blocked = {
      location: window.location,
      history: window.history,
      get sessionStorage(): Storage {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    expect(claimTrackingToken('OPS-12', blocked)).toBe(SAMPLE);
    expect(window.location.hash).toBe('');
    expect(claimTrackingToken('OPS-12', blocked)).toBeNull();
  });

  it('forgets a value on request', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    claimTrackingToken('OPS-12');
    forgetTrackingToken('OPS-12');
    expect(claimTrackingToken('OPS-12')).toBeNull();
  });
});

describe('the tab store', () => {
  it('is empty until claimed, then holds the value and tells subscribers', () => {
    expect(claimedToken('OPS-12')).toBeUndefined();
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    claimIntoStore('OPS-12');
    expect(claimedToken('OPS-12')).toBe(SAMPLE);
    expect(window.location.hash).toBe('');
    // Claiming again without a fragment (React runs effects twice in development) changes nothing.
    claimIntoStore('OPS-12');
    expect(claimedToken('OPS-12')).toBe(SAMPLE);
  });

  it('prefers a fresh link over what the tab holds, and drops everything on request', () => {
    go(`/portal/tickets/OPS-12#token=${SAMPLE}`);
    claimIntoStore('OPS-12');
    go('/portal/tickets/OPS-12#token=bmV3LWxpbms');
    claimIntoStore('OPS-12');
    expect(claimedToken('OPS-12')).toBe('bmV3LWxpbms');

    dropFromStore('OPS-12');
    expect(claimedToken('OPS-12')).toBeNull();
    expect(sessionStorage.getItem('wt-portal-token:OPS-12')).toBeNull();
  });
});
