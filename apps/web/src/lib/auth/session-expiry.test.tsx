import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TicketDetail } from '@watchtower/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/components/app-shell';
import { AuthGate } from '@/components/auth-gate';
import { useApi } from '@/lib/api/api-context';
import { RealtimeProvider } from '@/lib/realtime/realtime-provider';
import { draftStore } from '@/lib/tickets/templates';
import { renderApp } from '@/test-utils';
import { makeSession, makeTicket, uuid } from '@/test/fixtures';
import { socketFactory } from '@/test/fake-socket';
import { apiError } from '@/test/mock-api';
import { workspaceApi } from '@/test/scenarios';

import { endSession } from './end-session';
import { SESSION_HINT_KEY } from './session-hint';
import { SESSION_QUERY_KEY } from './session-key';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace }) }));

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  replace.mockReset();
});

const A_ID = uuid(900);
const B_ID = uuid(950);

const sessionOf = (who: 'A' | 'B') =>
  makeSession('agent', {
    user: {
      id: who === 'A' ? A_ID : B_ID,
      email: `${who.toLowerCase()}@example.com`,
      name: who === 'A' ? 'Alex Agent' : 'Bea Agent',
      role: 'agent',
      orgId: null,
    },
  });

/** Cache keys that belong to a person: `['user', id, ...]`. */
const userKeys = (client: QueryClient) =>
  client
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey)
    .filter((key) => key[0] === 'user');

/**
 * One tab, one API, two people in turn. `state` decides who the server believes is signed in and
 * whether the session has expired (every read answers 401 and the refresh fails too).
 */
function twoPeopleApi() {
  const tickets: Record<'A' | 'B', TicketDetail[]> = {
    A: [makeTicket(1, { subject: 'A secret ticket' }), makeTicket(2, { subject: 'A other' })],
    B: [makeTicket(1, { subject: 'B own ticket' })],
  };
  const state: { who: 'A' | 'B'; expired: boolean; listGate: Promise<void> | null } = {
    who: 'A',
    expired: false,
    listGate: null,
  };
  const unauthenticated = () => apiError(401, 'unauthenticated');
  workspaceApi({
    overrides: {
      'GET /v1/auth/session': () =>
        state.expired ? unauthenticated() : { json: sessionOf(state.who) },
      'POST /v1/auth/refresh': unauthenticated,
      'GET /v1/tickets': async () => {
        if (state.expired) return unauthenticated();
        if (state.listGate) await state.listGate;
        return { json: { items: tickets[state.who], nextCursor: null } };
      },
      'GET /v1/tickets/:id': ({ params }) => {
        if (state.expired) return unauthenticated();
        const found = tickets[state.who].find((ticket) => ticket.key === params.id);
        return found ? { json: found } : apiError(404, 'not_found');
      },
      'GET /v1/tickets/:id/timeline': () =>
        state.expired ? unauthenticated() : { json: { entries: [], nextCursor: null } },
    },
  });
  return state;
}

function openApp() {
  const handles: { client?: QueryClient; api?: ReturnType<typeof useApi> } = {};
  function Grab() {
    handles.client = useQueryClient();
    handles.api = useApi();
    return null;
  }
  const sockets = socketFactory();
  renderApp(
    <>
      <Grab />
      <AuthGate>
        <RealtimeProvider createSocket={sockets.create}>
          <AppShell />
        </RealtimeProvider>
      </AuthGate>
    </>,
  );
  const get = () => {
    if (!handles.client || !handles.api) throw new Error('app not rendered');
    return { client: handles.client, api: handles.api };
  };
  return get;
}

describe('endSession', () => {
  it('forgets drafts, the sign-in hint and every cached query but the session', () => {
    const client = new QueryClient();
    client.setQueryData(SESSION_QUERY_KEY, sessionOf('A'));
    client.setQueryData(['user', A_ID, 'tickets', 'list'], { pages: [] });
    client.setQueryData(['auth-config'], { google: null });
    draftStore.set('OPS-1', 'reply', 'half written');
    draftStore.set('OPS-1', 'note', 'private');
    localStorage.setItem(SESSION_HINT_KEY, '1');

    endSession(client);

    expect(draftStore.get('OPS-1', 'reply')).toBe('');
    expect(draftStore.get('OPS-1', 'note')).toBe('');
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([SESSION_QUERY_KEY]);
    expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  });
});

describe('a session that expires', () => {
  it('is cleaned up like a sign out, so the next person in the same tab sees nothing of the first', async () => {
    const user = userEvent.setup();
    const state = twoPeopleApi();
    const handles = openApp();

    // Person A works: opens a ticket and starts a reply.
    expect(await screen.findByText('A secret ticket')).toBeVisible();
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Public reply' }), 'draft for A');
    expect(draftStore.get('OPS-1', 'reply')).toBe('draft for A');
    expect(userKeys(handles().client).length).toBeGreaterThan(0);

    // The session ends behind A's back: the next call gets a 401 and the refresh fails too.
    state.expired = true;
    await act(async () => {
      await expect(handles().api.getTicket('OPS-2')).rejects.toThrow();
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/login');
    });

    // Exactly what sign out does: the unsent drafts and every cached query of A are gone.
    expect(screen.queryByText('A secret ticket')).not.toBeInTheDocument();
    expect(draftStore.get('OPS-1', 'reply')).toBe('');
    expect(userKeys(handles().client)).toEqual([]);
    expect(handles().client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull();

    // Person B signs in on the same tab (the login page ends with a session read like this one).
    // The ticket list is held back, so we see what B has before any data arrives.
    state.who = 'B';
    state.expired = false;
    let release: () => void = () => undefined;
    state.listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      await handles().api.session();
    });

    expect(await screen.findByRole('region', { name: 'Queue' })).toBeVisible();
    expect(screen.getByText('Loading tickets')).toBeInTheDocument();
    expect(screen.queryByText('A secret ticket')).not.toBeInTheDocument();
    expect(screen.queryByText('A other')).not.toBeInTheDocument();

    release();
    expect(await screen.findByText('B own ticket')).toBeVisible();
    expect(screen.queryByText('A secret ticket')).not.toBeInTheDocument();

    // The same ticket key is open (the address still names it), and B's composer is empty.
    expect(await screen.findByRole('textbox', { name: 'Public reply' })).toHaveValue('');

    // Everything cached now belongs to B.
    const keys = userKeys(handles().client);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key[1] === B_ID)).toBe(true);
  });

  it('is also handled when another person takes over the session without a gap', async () => {
    const user = userEvent.setup();
    const state = twoPeopleApi();
    const handles = openApp();

    expect(await screen.findByText('A secret ticket')).toBeVisible();
    await user.click(screen.getByRole('option', { name: /OPS-1/ }));
    await user.type(await screen.findByRole('textbox', { name: 'Public reply' }), 'draft for A');

    // A refresh (or a session read) now returns somebody else.
    state.who = 'B';
    await act(async () => {
      await handles().api.session();
    });

    expect(await screen.findByText('B own ticket')).toBeVisible();
    expect(screen.queryByText('A secret ticket')).not.toBeInTheDocument();
    expect(draftStore.get('OPS-1', 'reply')).toBe('');
    expect(userKeys(handles().client).every((key) => key[1] === B_ID)).toBe(true);
  });
});
