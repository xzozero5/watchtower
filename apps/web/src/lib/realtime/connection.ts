import {
  REALTIME_CLOSE_CODES,
  REALTIME_PATH,
  realtimeEventSchema,
  realtimeReadySchema,
  type RealtimeEvent,
} from '@watchtower/shared';

/**
 * - `connecting`: opening the socket, or waiting for the server's `ready` frame
 * - `open`: live updates are flowing
 * - `reconnecting`: the socket dropped; a retry is scheduled (exponential backoff)
 * - `paused`: the server closed this tab's socket because the user has too many open (4429); the
 *   tab does not retry by itself, or tabs would keep evicting each other
 * - `forbidden`: this user may not listen at all (4403); no retry
 * - `ended`: the session is over; the auth gate shows the login page
 */
export type ConnectionState =
  'connecting' | 'open' | 'reconnecting' | 'paused' | 'forbidden' | 'ended';

/** The part of the browser `WebSocket` the connection uses, so tests can supply a fake. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 30_000 };

/**
 * Delay before retry number `attempt` (0 based): doubles from `baseMs` up to `maxMs`, with "equal
 * jitter" (between half and all of the step) so many tabs do not reconnect in the same instant.
 */
export function backoffDelay(
  attempt: number,
  random: () => number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const step = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(step / 2 + (step / 2) * random());
}

/** `http://api:4000` to `ws://api:4000/v1/realtime`, `https` to `wss`. */
export function realtimeUrl(apiUrl: string): string {
  const url = new URL(REALTIME_PATH, `${apiUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export interface Timers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const BROWSER_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface RealtimeConnectionOptions {
  url: string;
  createSocket: (url: string) => SocketLike;
  onEvent: (event: RealtimeEvent) => void;
  onState: (state: ConnectionState) => void;
  /**
   * Called when the socket is live again after a gap, so the app can refetch what it may have
   * missed (the feed has no replay).
   */
  onResync: () => void;
  /**
   * Checks that the session still works before a reconnect, refreshing it if the access token
   * expired. Browsers hide the HTTP status of a refused WebSocket handshake (it is just a 1006
   * close), so the connection cannot tell an expired cookie from a network problem by itself.
   * Resolves false when the session is over.
   */
  ensureSession: () => Promise<boolean>;
  backoff?: BackoffOptions;
  random?: () => number;
  timers?: Timers;
}

/**
 * The browser end of `/v1/realtime`: a one-way feed of events. It reconnects with exponential
 * backoff and jitter, refreshes the session when the server says the access token expired (4401),
 * and stops for good on 4403 and when the session ends. It never sends anything to the server.
 */
export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private stopped = true;
  private everOpened = false;
  private needsResync = false;
  /** Bumps on every connect so a late callback from an old socket is ignored. */
  private generation = 0;
  private readonly backoff: BackoffOptions;
  private readonly random: () => number;
  private readonly timers: Timers;

  constructor(private readonly options: RealtimeConnectionOptions) {
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.random = options.random ?? Math.random;
    this.timers = options.timers ?? BROWSER_TIMERS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close(1000, 'client_stopped');
    }
  }

  /** The browser came back online or the user asked: try now instead of waiting for the timer. */
  retryNow(): void {
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.socket === null && this.timer !== null) {
      this.clearTimer();
      this.attempt = 0;
      void this.reconnect(true);
    }
  }

  private get isStopped(): boolean {
    return this.stopped;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private connect(): void {
    const generation = (this.generation += 1);
    this.options.onState(this.everOpened || this.attempt > 0 ? 'reconnecting' : 'connecting');
    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    let ready = false;

    socket.onmessage = (message) => {
      if (generation !== this.generation || typeof message.data !== 'string') return;
      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!ready) {
        if (realtimeReadySchema.safeParse(json).success) {
          ready = true;
          this.attempt = 0;
          this.options.onState('open');
          if (this.needsResync) {
            this.needsResync = false;
            this.options.onResync();
          }
          this.everOpened = true;
        }
        return;
      }
      const event = realtimeEventSchema.safeParse(json);
      if (event.success) this.options.onEvent(event.data);
    };

    socket.onclose = (closeEvent) => {
      if (generation !== this.generation) return;
      this.socket = null;
      // Anything missed while the socket was down is only recoverable by refetching.
      if (ready || this.everOpened) this.needsResync = true;
      this.handleClose(closeEvent.code, ready);
    };
    // The browser always follows an error with a close event, which is where the handling is.
    socket.onerror = () => undefined;
  }

  private handleClose(code: number, wasReady: boolean): void {
    if (this.stopped) return;
    if (code === REALTIME_CLOSE_CODES.forbidden) {
      this.options.onState('forbidden');
      this.stopped = true;
      return;
    }
    if (code === REALTIME_CLOSE_CODES.tooManyConnections) {
      this.options.onState('paused');
      this.stopped = true;
      return;
    }
    // 4401 says so outright; a handshake that never completed may be an expired cookie too.
    const maybeAuth = code === REALTIME_CLOSE_CODES.unauthenticated || !wasReady;
    if (code === REALTIME_CLOSE_CODES.unauthenticated) this.attempt = 0;
    this.scheduleRetry(maybeAuth);
  }

  private scheduleRetry(checkSession = false): void {
    if (this.stopped) return;
    this.options.onState('reconnecting');
    const delay =
      this.attempt === 0 && checkSession
        ? 0
        : backoffDelay(this.attempt, this.random, this.backoff);
    this.attempt += 1;
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.reconnect(checkSession);
    }, delay);
  }

  private async reconnect(checkSession = false): Promise<void> {
    if (this.stopped) return;
    const generation = this.generation;
    if (checkSession) {
      let alive: boolean;
      try {
        alive = await this.options.ensureSession();
      } catch {
        // The api could not be reached: not a verdict on the session. Keep backing off.
        if (generation === this.generation) this.scheduleRetry(true);
        return;
      }
      // stop() may have run while the check was in flight; `stopped` is re-read through a getter
      // because TypeScript cannot see that a call during the await changed it.
      if (generation !== this.generation || this.isStopped) return;
      if (!alive) {
        this.stopped = true;
        this.options.onState('ended');
        return;
      }
    }
    this.connect();
  }
}
