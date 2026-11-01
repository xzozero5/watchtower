'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useApi } from '@/lib/api/api-context';
import { useUserId } from '@/lib/auth/session';
import { isUnauthenticated } from '@/lib/api/errors';
import { notificationKeys } from '@/lib/notifications/keys';
import { useRuntimeConfig } from '@/lib/runtime-config-context';
import { ticketKeys } from '@/lib/tickets/queries';

import {
  type ConnectionState,
  RealtimeConnection,
  realtimeUrl,
  type SocketLike,
} from './connection';
import type { NewTicket } from './new-tickets';
import { applyRealtimeEvent } from './sync';

export type SocketFactory = (url: string) => SocketLike;

/** Wraps the browser WebSocket in the small interface the connection needs. */
export const browserSocket: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: (code, reason) => {
      ws.close(code, reason);
    },
  };
  ws.onopen = (event) => socket.onopen?.(event);
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data as unknown });
  ws.onclose = (event) => socket.onclose?.({ code: event.code });
  ws.onerror = (event) => socket.onerror?.(event);
  return socket;
};

export interface RealtimeValue {
  state: ConnectionState;
  /**
   * Tickets created since the queue was last loaded, with their org, queue and channel. The "N new"
   * pill counts the ones that match the filter on screen (`countNewMatching`).
   */
  newTickets: readonly NewTicket[];
  clearNewTickets: () => void;
  /** Reconnect now (after the server paused this tab, or the browser came back online). */
  retry: () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

/** Connects to the api WebSocket while mounted and keeps the query cache in step with it. */
export function RealtimeProvider({
  children,
  createSocket = browserSocket,
}: {
  children: ReactNode;
  createSocket?: SocketFactory;
}) {
  const { apiUrl } = useRuntimeConfig();
  const api = useApi();
  const userId = useUserId();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');
  const [newTickets, setNewTickets] = useState<readonly NewTicket[]>([]);
  const connectionRef = useRef<RealtimeConnection | null>(null);

  useEffect(() => {
    const connection = new RealtimeConnection({
      url: realtimeUrl(apiUrl),
      createSocket,
      onState: setState,
      onEvent: (event) => {
        applyRealtimeEvent(event, {
          queryClient,
          userId,
          api,
          onNewTicket: (ticket) => {
            setNewTickets((known) =>
              known.some((item) => item.id === ticket.id) ? known : [...known, ticket],
            );
          },
        });
      },
      onResync: () => {
        void queryClient.invalidateQueries({ queryKey: ticketKeys(userId).all });
        // Notifications have no replay either: a P1 that arrived while the socket was down shows now.
        void queryClient.invalidateQueries({ queryKey: notificationKeys(userId).all });
      },
      ensureSession: async () => {
        try {
          await api.session();
          return true;
        } catch (error) {
          if (isUnauthenticated(error)) return false;
          throw error;
        }
      },
    });
    connectionRef.current = connection;
    connection.start();

    const onOnline = () => {
      connection.retryNow();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      connection.stop();
      connectionRef.current = null;
    };
  }, [apiUrl, api, queryClient, userId, createSocket]);

  const clearNewTickets = useCallback(() => {
    setNewTickets([]);
  }, []);
  const retry = useCallback(() => {
    connectionRef.current?.retryNow();
  }, []);

  const value = useMemo<RealtimeValue>(
    () => ({ state, newTickets, clearNewTickets, retry }),
    [state, newTickets, clearNewTickets, retry],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}
