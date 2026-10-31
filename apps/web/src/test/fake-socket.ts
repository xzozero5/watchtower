import type { RealtimeEvent } from '@watchtower/shared';

import type { SocketLike } from '@/lib/realtime/connection';

/** A WebSocket stand-in the tests drive by hand. */
export class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;

  constructor(readonly url: string) {}

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  open(): void {
    this.onopen?.({});
  }

  /** The server's first frame. */
  ready(audience: 'staff' | 'client' = 'staff'): void {
    this.send({
      type: 'ready',
      audience,
      accessExpiresAt: '2026-11-02T03:15:00.000Z',
    });
  }

  send(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  event(event: RealtimeEvent): void {
    this.send(event);
  }

  serverClose(code: number): void {
    this.onclose?.({ code });
  }
}

/** Collects every socket a factory creates, newest last. */
export function socketFactory() {
  const sockets: FakeSocket[] = [];
  const create = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  return {
    create,
    sockets,
    get last(): FakeSocket {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('no socket was created');
      return socket;
    },
  };
}

let eventCounter = 0;

export function ticketCreatedEvent(ticket: {
  id: string;
  key: string;
  subject: string;
}): RealtimeEvent {
  eventCounter += 1;
  return {
    id: `b0000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`,
    type: 'ticket.created',
    occurredAt: '2026-11-02T03:01:00.000Z',
    orgId: 'a0000000-0000-4000-8000-000000000500',
    ticketId: ticket.id,
    ticketKey: ticket.key,
    data: { subject: ticket.subject, status: 'new', priority: 'P3', changed: [] },
  };
}
