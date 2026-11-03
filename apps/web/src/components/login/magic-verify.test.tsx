import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { makeSession } from '@/test/fixtures';
import { apiError, mockApi, type MockHandler } from '@/test/mock-api';

import { MagicVerify, readMagicToken } from './magic-verify';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
  window.history.replaceState(null, '', '/');
});

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

function openLink(hash: string, routes: Record<string, MockHandler> = {}) {
  window.history.replaceState(null, '', `/login/magic${hash}`);
  const api = mockApi({ 'GET /v1/auth/session': apiError(401, 'unauthenticated'), ...routes });
  renderApp(<MagicVerify />);
  return api;
}

describe('readMagicToken', () => {
  it('reads the token from the fragment', () => {
    expect(readMagicToken(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readMagicToken(`token=${TOKEN}`)).toBe(TOKEN);
  });

  it('rejects a missing or too short token', () => {
    expect(readMagicToken('')).toBeNull();
    expect(readMagicToken('#token=short')).toBeNull();
    expect(readMagicToken('#other=1')).toBeNull();
  });
});

describe('MagicVerify', () => {
  it('posts the token once, removes it from the address bar and goes to the start page', async () => {
    const api = openLink(`#token=${TOKEN}`, {
      'POST /v1/auth/magic-link/verify': { json: makeSession('client') },
    });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/start');
    });
    expect(api.callsTo('/v1/auth/magic-link/verify', 'POST')).toHaveLength(1);
    expect(api.callsTo('/v1/auth/magic-link/verify', 'POST')[0]?.body).toEqual({ token: TOKEN });
    // The one-time secret does not stay in the address bar or the history.
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('shows that it is checking, with a status for screen readers', () => {
    openLink(`#token=${TOKEN}`, {
      'POST /v1/auth/magic-link/verify': () => new Promise(() => undefined),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Checking your sign-in link');
  });

  it('tells the user to ask for a new link when it was used or has expired', async () => {
    const api = openLink(`#token=${TOKEN}`, {
      'POST /v1/auth/magic-link/verify': apiError(401, 'invalid_or_expired_link'),
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This sign-in link cannot be used');
    expect(alert).toHaveTextContent('It has expired, was already used, or is incomplete.');
    expect(screen.getByRole('link', { name: 'Back to sign-in' })).toHaveAttribute('href', '/login');
    expect(replace).not.toHaveBeenCalled();
    // A used token is not worth retrying, and a failed sign-in must not trigger a refresh.
    expect(api.callsTo('/v1/auth/magic-link/verify')).toHaveLength(1);
    expect(api.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('fails without calling the api when the link has no token', async () => {
    const api = openLink('');
    expect(await screen.findByRole('alert')).toHaveTextContent('This sign-in link cannot be used');
    expect(api.callsTo('/v1/auth/magic-link/verify')).toHaveLength(0);
  });
});
