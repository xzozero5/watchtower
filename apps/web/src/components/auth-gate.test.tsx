import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '@/test-utils';
import { makeSession } from '@/test/fixtures';
import { apiError, mockApi } from '@/test/mock-api';

import { AuthGate } from './auth-gate';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh: vi.fn() }),
}));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

const gate = () =>
  renderApp(
    <AuthGate>
      <p>secret workspace</p>
    </AuthGate>,
  );

describe('AuthGate', () => {
  it('shows a loading state, then the content for a signed-in user', async () => {
    mockApi({ 'GET /v1/auth/session': { json: makeSession('agent') } });
    gate();
    expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
    expect(screen.queryByText('secret workspace')).not.toBeInTheDocument();
    expect(await screen.findByText('secret workspace')).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to the login page and never shows the content', async () => {
    const api = mockApi({ 'GET /v1/auth/session': apiError(401, 'unauthenticated') });
    gate();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
    expect(screen.queryByText('secret workspace')).not.toBeInTheDocument();
    // Never signed in here, so there is nothing to refresh.
    expect(api.callsTo('/v1/auth/refresh')).toHaveLength(0);
  });

  it('renews an expired session before deciding, when this browser had one', async () => {
    localStorage.setItem('wt-had-session', '1');
    let calls = 0;
    const api = mockApi({
      'GET /v1/auth/session': () => {
        calls += 1;
        return calls === 1 ? apiError(401, 'unauthenticated') : { json: makeSession('agent') };
      },
      'POST /v1/auth/refresh': { json: makeSession('agent') },
    });
    gate();
    expect(await screen.findByText('secret workspace')).toBeVisible();
    expect(api.callsTo('/v1/auth/refresh', 'POST')).toHaveLength(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('goes to the login page when the refresh token is refused too', async () => {
    localStorage.setItem('wt-had-session', '1');
    mockApi({
      'GET /v1/auth/session': apiError(401, 'unauthenticated'),
      'POST /v1/auth/refresh': apiError(401, 'invalid_refresh_token'),
    });
    gate();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
    // The hint is dropped so the next visit does not try again.
    expect(localStorage.getItem('wt-had-session')).toBeNull();
  });

  it('says the api is unreachable instead of bouncing to login, and can retry', async () => {
    const user = userEvent.setup();
    let down = true;
    mockApi({
      'GET /v1/auth/session': () =>
        down ? apiError(503, 'unknown') : { json: makeSession('agent') },
    });
    gate();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check your session');
    expect(replace).not.toHaveBeenCalled();

    down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('secret workspace')).toBeVisible();
  });
});
