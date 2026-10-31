import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { REALTIME_CLOSE_CODES } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWorkspace } from '@/test-utils';
import { makeSession } from '@/test/fixtures';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

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

async function connected() {
  const view = renderWorkspace();
  await screen.findByRole('region', { name: 'Queue' });
  await waitFor(() => {
    expect(view.sockets.sockets).toHaveLength(1);
  });
  await act(async () => {
    view.sockets.last.ready();
    await Promise.resolve();
  });
  return view;
}

const liveText = () => screen.getByTestId('live-status').textContent;

describe('RealtimeProvider', () => {
  it('connects to the api WebSocket path and shows the connection in words', async () => {
    workspaceApi();
    const view = renderWorkspace();
    await screen.findByRole('region', { name: 'Queue' });
    await waitFor(() => {
      expect(view.sockets.sockets).toHaveLength(1);
    });
    // http://api.test in the test config becomes ws://api.test.
    expect(view.sockets.last.url).toBe('ws://api.test/v1/realtime');
    expect(liveText()).toBe('Connecting');

    await act(async () => {
      view.sockets.last.ready();
      await Promise.resolve();
    });
    expect(liveText()).toBe('Live');
  });

  it('reconnects after a drop, then refetches what it may have missed', async () => {
    const api = workspaceApi();
    const view = await connected();
    await screen.findByText('Cannot log in');
    const before = api.callsTo('/v1/tickets').length;

    await act(async () => {
      view.sockets.last.serverClose(1006);
      await Promise.resolve();
    });
    expect(liveText()).toBe('Reconnecting');

    // Backoff with jitter: the retry comes within the first step (1 s), not at once.
    await waitFor(
      () => {
        expect(view.sockets.sockets).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    await act(async () => {
      view.sockets.last.ready();
      await Promise.resolve();
    });
    expect(liveText()).toBe('Live');
    await waitFor(() => {
      expect(api.callsTo('/v1/tickets').length).toBeGreaterThan(before);
    });
  });

  it('on 4401 renews the session and reconnects', async () => {
    localStorage.setItem('wt-had-session', '1');
    let sessionCalls = 0;
    const api = workspaceApi({
      overrides: {
        'GET /v1/auth/session': () => {
          sessionCalls += 1;
          // Open, then the access token expires before the reconnect check.
          return sessionCalls === 2
            ? apiError(401, 'unauthenticated')
            : { json: makeSession('agent') };
        },
        'POST /v1/auth/refresh': { json: makeSession('agent') },
      },
    });
    const view = await connected();

    await act(async () => {
      view.sockets.last.serverClose(REALTIME_CLOSE_CODES.unauthenticated);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.sockets.sockets).toHaveLength(2);
    });
    expect(api.callsTo('/v1/auth/refresh', 'POST')).toHaveLength(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('on 4401 with no way to renew, stops and sends the user to the login page', async () => {
    localStorage.setItem('wt-had-session', '1');
    let sessionCalls = 0;
    workspaceApi({
      overrides: {
        'GET /v1/auth/session': () => {
          sessionCalls += 1;
          return sessionCalls === 1
            ? { json: makeSession('agent') }
            : apiError(401, 'unauthenticated');
        },
        'POST /v1/auth/refresh': apiError(401, 'invalid_refresh_token'),
      },
    });
    const view = await connected();

    await act(async () => {
      view.sockets.last.serverClose(REALTIME_CLOSE_CODES.unauthenticated);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });
    expect(view.sockets.sockets).toHaveLength(1);
  });

  it('says live updates are unavailable when the server refuses this user (4403)', async () => {
    workspaceApi();
    const view = await connected();
    await act(async () => {
      view.sockets.last.serverClose(REALTIME_CLOSE_CODES.forbidden);
      await Promise.resolve();
    });
    expect(liveText()).toBe('Live updates are not available');
    expect(view.sockets.sockets).toHaveLength(1);
  });

  it('pauses when the server evicts this tab (4429) and reconnects only when asked', async () => {
    const user = userEvent.setup();
    workspaceApi();
    const view = await connected();
    await act(async () => {
      view.sockets.last.serverClose(REALTIME_CLOSE_CODES.tooManyConnections);
      await Promise.resolve();
    });
    expect(liveText()).toContain('Live updates paused in this tab');
    // No automatic retry that would evict another tab in turn.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(view.sockets.sockets).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => {
      expect(view.sockets.sockets).toHaveLength(2);
    });
  });

  it('closes the socket when the workspace goes away', async () => {
    workspaceApi();
    const view = await connected();
    const socket = view.sockets.last;
    view.unmount();
    expect(socket.closed?.code).toBe(1000);
  });
});
