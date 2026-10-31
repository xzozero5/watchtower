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
import { isUnauthenticated } from '@/lib/api/errors';
import { useRuntimeConfig } from '@/lib/runtime-config-context';
import { ticketKeys } from '@/lib/tickets/queries';

import {
  type ConnectionState,
  RealtimeConnection,
  realtimeUrl,
  type SocketLike,
} from './connection';
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
  /** Tickets created since the queue was last loaded. Drives the "N new" pill. */
  newTicketIds: readonly string[];
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
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>('connecting');
  const [newTicketIds, setNewTicketIds] = useState<readonly string[]>([]);
  const connectionRef = useRef<RealtimeConnection | null>(null);

  useEffect(() => {
    const connection = new RealtimeConnection({
      url: realtimeUrl(apiUrl),
      createSocket,
      onState: setState,
      onEvent: (event) => {
        applyRealtimeEvent(event, {
          queryClient,
          api,
          onNewTicket: (ticketId) => {
            setNewTicketIds((ids) => (ids.includes(ticketId) ? ids : [...ids, ticketId]));
          },
        });
      },
      onResync: () => {
        void queryClient.invalidateQueries({ queryKey: ticketKeys.all });
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
  }, [apiUrl, api, queryClient, createSocket]);

  const clearNewTickets = useCallback(() => {
    setNewTicketIds([]);
  }, []);
  const retry = useCallback(() => {
    connectionRef.current?.retryNow();
  }, []);

  const value = useMemo<RealtimeValue>(
    () => ({ state, newTicketIds, clearNewTickets, retry }),
    [state, newTicketIds, clearNewTickets, retry],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}
