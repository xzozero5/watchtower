import { QueryClient } from '@tanstack/react-query';
import type { RealtimeEvent } from '@watchtower/shared';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FILTERS } from '@/lib/tickets/filters';
import { ticketKeys } from '@/lib/tickets/queries';
import { makeTicket } from '@/test/fixtures';
import { ticketCreatedEvent } from '@/test/fake-socket';

import { applyRealtimeEvent, isTicketCached } from './sync';

function updatedEvent(ticket: { id: string; key: string }): RealtimeEvent {
  return {
    id: 'b0000000-0000-4000-8000-0000000000aa',
    type: 'ticket.updated',
    occurredAt: '2026-11-02T03:02:00.000Z',
    orgId: 'a0000000-0000-4000-8000-000000000500',
    ticketId: ticket.id,
    ticketKey: ticket.key,
    data: { subject: 's', status: 'resolved', priority: 'P3', changed: ['status'] },
  };
}

function setup() {
  const queryClient = new QueryClient();
  const getTicket = vi.fn();
  const onNewTicket = vi.fn();
  return {
    queryClient,
    getTicket,
    onNewTicket,
    deps: { queryClient, api: { getTicket }, onNewTicket },
  };
}

describe('applyRealtimeEvent', () => {
  it('counts a new ticket but never touches the list, so rows do not move', () => {
    const { queryClient, onNewTicket, deps } = setup();
    const ticket = makeTicket(1);
    queryClient.setQueryData(ticketKeys.list(DEFAULT_FILTERS), {
      pages: [{ items: [ticket], nextCursor: null }],
      pageParams: [undefined],
    });

    applyRealtimeEvent(ticketCreatedEvent(makeTicket(2)), deps);

    expect(onNewTicket).toHaveBeenCalledWith(makeTicket(2).id);
    const list = queryClient.getQueryData<{ pages: { items: unknown[] }[] }>(
      ticketKeys.list(DEFAULT_FILTERS),
    );
    expect(list?.pages[0]?.items).toEqual([ticket]);
  });

  it('re-reads an updated ticket and replaces its row in place', async () => {
    const { queryClient, getTicket, deps } = setup();
    const before = makeTicket(1, { status: 'open' });
    const other = makeTicket(2);
    queryClient.setQueryData(ticketKeys.list(DEFAULT_FILTERS), {
      pages: [{ items: [other, before], nextCursor: null }],
      pageParams: [undefined],
    });
    const after = makeTicket(1, { status: 'resolved' });
    getTicket.mockResolvedValue(after);

    applyRealtimeEvent(updatedEvent(before), deps);
    await vi.waitFor(() => {
      expect(getTicket).toHaveBeenCalledWith(before.key);
    });

    await vi.waitFor(() => {
      const list = queryClient.getQueryData<{
        pages: { items: { key: string; status: string }[] }[];
      }>(ticketKeys.list(DEFAULT_FILTERS));
      // Same position, new content.
      expect(list?.pages[0]?.items.map((item) => `${item.key}:${item.status}`)).toEqual([
        `${other.key}:open`,
        `${before.key}:resolved`,
      ]);
    });
    expect(queryClient.getQueryData(ticketKeys.detail(before.key))).toEqual(after);
  });

  it('ignores updates to tickets this tab has never loaded', () => {
    const { getTicket, deps } = setup();
    applyRealtimeEvent(updatedEvent(makeTicket(5)), deps);
    expect(getTicket).not.toHaveBeenCalled();
  });

  it('refetches the timeline when a message arrives', () => {
    const { queryClient, deps } = setup();
    const ticket = makeTicket(3);
    queryClient.setQueryData(ticketKeys.timeline(ticket.key), { pages: [], pageParams: [] });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    applyRealtimeEvent(
      {
        id: 'b0000000-0000-4000-8000-0000000000bb',
        type: 'message.created',
        occurredAt: '2026-11-02T03:03:00.000Z',
        orgId: 'a0000000-0000-4000-8000-000000000500',
        ticketId: ticket.id,
        ticketKey: ticket.key,
        data: {
          messageId: 'c0000000-0000-4000-8000-000000000001',
          direction: 'inbound',
          visibility: 'public',
        },
      },
      deps,
    );

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ticketKeys.timeline(ticket.key) });
  });
});

describe('isTicketCached', () => {
  it('is true for an open detail or a loaded row, false otherwise', () => {
    const { queryClient } = setup();
    const a = makeTicket(1);
    const b = makeTicket(2);
    queryClient.setQueryData(ticketKeys.detail(a.key), a);
    queryClient.setQueryData(ticketKeys.list(DEFAULT_FILTERS), {
      pages: [{ items: [b], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(isTicketCached(queryClient, a.id, a.key)).toBe(true);
    expect(isTicketCached(queryClient, b.id, b.key)).toBe(true);
    expect(isTicketCached(queryClient, makeTicket(9).id, 'OPS-9')).toBe(false);
  });
});
