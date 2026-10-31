import { REALTIME_CLOSE_CODES } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { makeTicket } from '@/test/fixtures';
import { type FakeSocket, socketFactory, ticketCreatedEvent } from '@/test/fake-socket';

import {
  backoffDelay,
  type ConnectionState,
  RealtimeConnection,
  type RealtimeConnectionOptions,
  realtimeUrl,
  type Timers,
} from './connection';

/** Timers the test advances by hand, so backoff delays are exact and nothing waits in real time. */
function manualTimers() {
  const pending: { id: number; at: number; callback: () => void }[] = [];
  let now = 0;
  let nextId = 1;
  const timers: Timers = {
    set(callback, ms) {
      const id = nextId++;
      pending.push({ id, at: now + ms, callback });
      return id;
    },
    clear(handle) {
      const index = pending.findIndex((entry) => entry.id === handle);
      if (index >= 0) pending.splice(index, 1);
    },
  };
  return {
    timers,
    get delays() {
      return pending.map((entry) => entry.at - now);
    },
    get count() {
      return pending.length;
    },
    /** Runs the next timer and returns how long it waited. */
    fireNext(): number {
      pending.sort((a, b) => a.at - b.at);
      const next = pending.shift();
      if (!next) throw new Error('no timer is pending');
      const waited = next.at - now;
      now = next.at;
      next.callback();
      return waited;
    },
  };
}

function setup(overrides: Partial<RealtimeConnectionOptions> = {}) {
  const sockets = socketFactory();
  const clock = manualTimers();
  const states: ConnectionState[] = [];
  const events: unknown[] = [];
  const onResync = vi.fn();
  const ensureSession = vi.fn(() => Promise.resolve(true));
  const connection = new RealtimeConnection({
    url: 'ws://api.test/v1/realtime',
    createSocket: sockets.create,
    onEvent: (event) => events.push(event),
    onState: (state) => states.push(state),
    onResync,
    ensureSession,
    random: () => 0.5,
    timers: clock.timers,
    ...overrides,
  });
  return { connection, sockets, clock, states, events, onResync, ensureSession };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('realtimeUrl', () => {
  it('maps http to ws and https to wss and appends the realtime path', () => {
    expect(realtimeUrl('http://localhost:4000')).toBe('ws://localhost:4000/v1/realtime');
    expect(realtimeUrl('https://api.example.com')).toBe('wss://api.example.com/v1/realtime');
  });
});

describe('backoffDelay', () => {
  it('doubles up to the cap and keeps jitter between half and the whole step', () => {
    const options = { baseMs: 1000, maxMs: 8000 };
    expect(backoffDelay(0, () => 1, options)).toBe(1000);
    expect(backoffDelay(0, () => 0, options)).toBe(500);
    expect(backoffDelay(1, () => 1, options)).toBe(2000);
    expect(backoffDelay(2, () => 1, options)).toBe(4000);
    expect(backoffDelay(3, () => 1, options)).toBe(8000);
    expect(backoffDelay(10, () => 1, options)).toBe(8000);
    expect(backoffDelay(10, () => 0, options)).toBe(4000);
  });
});

describe('RealtimeConnection', () => {
  it('is connecting until the server says ready, then open', () => {
    const { connection, sockets, states } = setup();
    connection.start();
    expect(states).toEqual(['connecting']);
    sockets.last.open();
    expect(states).toEqual(['connecting']);
    sockets.last.ready();
    expect(states).toEqual(['connecting', 'open']);
    expect(sockets.last.url).toBe('ws://api.test/v1/realtime');
  });

  it('passes valid events on and drops garbage', () => {
    const { connection, sockets, events } = setup();
    connection.start();
    sockets.last.ready();
    const created = ticketCreatedEvent(makeTicket(7));
    sockets.last.event(created);
    sockets.last.send({ type: 'something.else' });
    sockets.last.onmessage?.({ data: 'not json' });
    sockets.last.onmessage?.({ data: new ArrayBuffer(2) });
    expect(events).toEqual([created]);
  });

  it('reconnects with growing delays and resets them once a connection is ready', async () => {
    const { connection, sockets, clock, states } = setup();
    connection.start();

    // The first handshake fails twice before it works. random=0.5 gives 75% of each step.
    sockets.last.serverClose(1006);
    expect(states.at(-1)).toBe('reconnecting');
    // A handshake that never completed might be an expired cookie, so the first retry is at once
    // (after checking the session); later ones back off.
    expect(clock.delays).toEqual([0]);
    expect(clock.fireNext()).toBe(0);
    await flush();
    expect(sockets.sockets).toHaveLength(2);

    sockets.last.serverClose(1006);
    expect(clock.delays).toEqual([1500]);
    clock.fireNext();
    await flush();
    sockets.last.serverClose(1006);
    expect(clock.delays).toEqual([3000]);
    clock.fireNext();
    await flush();
    expect(sockets.sockets).toHaveLength(4);

    sockets.last.ready();
    expect(states.at(-1)).toBe('open');

    sockets.last.serverClose(1001);
    // After a good connection the next drop starts from the smallest delay again.
    expect(clock.delays).toEqual([750]);
  });

  it('asks the app to refetch after a gap, but not on the very first connection', async () => {
    const { connection, sockets, clock, onResync } = setup();
    connection.start();
    sockets.last.ready();
    expect(onResync).not.toHaveBeenCalled();

    sockets.last.serverClose(1006);
    clock.fireNext();
    await flush();
    sockets.last.ready();
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('on 4401 checks the session (which refreshes it) and reconnects at once', async () => {
    const { connection, sockets, clock, ensureSession, states } = setup();
    connection.start();
    sockets.last.ready();

    sockets.last.serverClose(REALTIME_CLOSE_CODES.unauthenticated);
    expect(states.at(-1)).toBe('reconnecting');
    expect(clock.delays).toEqual([0]);
    clock.fireNext();
    await flush();

    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(sockets.sockets).toHaveLength(2);
  });

  it('ends when the session is over instead of reconnecting forever', async () => {
    const ensureSession = vi.fn(() => Promise.resolve(false));
    const { connection, sockets, clock, states } = setup({ ensureSession });
    connection.start();
    sockets.last.ready();
    sockets.last.serverClose(REALTIME_CLOSE_CODES.unauthenticated);
    clock.fireNext();
    await flush();

    expect(states.at(-1)).toBe('ended');
    expect(sockets.sockets).toHaveLength(1);
    expect(clock.count).toBe(0);
  });

  it('keeps backing off when the api cannot be reached to check the session', async () => {
    const ensureSession = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    const { connection, sockets, clock, states } = setup({ ensureSession });
    connection.start();
    sockets.last.serverClose(1006);
    clock.fireNext();
    await flush();
    expect(states.at(-1)).toBe('reconnecting');
    expect(clock.count).toBe(1);
    expect(sockets.sockets).toHaveLength(1);

    clock.fireNext();
    await flush();
    expect(sockets.sockets).toHaveLength(2);
  });

  it('stops for good on 4403 (not allowed to listen)', () => {
    const { connection, sockets, clock, states } = setup();
    connection.start();
    sockets.last.serverClose(REALTIME_CLOSE_CODES.forbidden);
    expect(states.at(-1)).toBe('forbidden');
    expect(clock.count).toBe(0);
  });

  it('pauses on 4429 and does not retry by itself, so tabs do not evict each other', () => {
    const { connection, sockets, clock, states } = setup();
    connection.start();
    sockets.last.ready();
    sockets.last.serverClose(REALTIME_CLOSE_CODES.tooManyConnections);
    expect(states.at(-1)).toBe('paused');
    expect(clock.count).toBe(0);

    // The user can bring it back.
    connection.retryNow();
    expect(sockets.sockets).toHaveLength(2);
  });

  it('retryNow skips the wait when the browser is back online', async () => {
    const { connection, sockets, clock } = setup();
    connection.start();
    sockets.last.ready();
    sockets.last.serverClose(1006);
    expect(clock.count).toBe(1);

    connection.retryNow();
    await flush();
    expect(clock.count).toBe(0);
    expect(sockets.sockets).toHaveLength(2);
  });

  it('stop closes the socket, cancels the timer and ignores late callbacks', () => {
    const { connection, sockets, clock, states, events } = setup();
    connection.start();
    const first: FakeSocket = sockets.last;
    first.ready();
    connection.stop();
    expect(first.closed?.code).toBe(1000);

    first.serverClose(1006);
    first.event(ticketCreatedEvent(makeTicket(8)));
    expect(clock.count).toBe(0);
    expect(events).toEqual([]);
    expect(states.at(-1)).toBe('open');
  });

  it('ignores a stale socket after a reconnect', async () => {
    const { connection, sockets, clock, events } = setup();
    connection.start();
    const old = sockets.last;
    old.ready();
    old.serverClose(1006);
    clock.fireNext();
    await flush();
    sockets.last.ready();

    old.event(ticketCreatedEvent(makeTicket(9)));
    expect(events).toEqual([]);
  });
});
