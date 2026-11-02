import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  REALTIME_CLOSE_CODES,
  REALTIME_PATH,
  realtimeEventFor,
  realtimeEventSchema,
  type RealtimeAudience,
} from '@watchtower/shared';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';

import { AuthService } from '../auth/auth.service.js';
import { cookieNames, parseCookieHeader } from '../auth/cookies.js';
import type { Principal } from '../auth/principal.js';
import { SessionService } from '../auth/session.service.js';
import { TokenService } from '../auth/token.service.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { REDIS } from '../redis/redis.module.js';
import { REALTIME_CHANNEL_NAME } from './realtime-publisher.js';

/** At most this many open sockets per user (a few tabs and devices); the oldest is closed beyond it. */
const MAX_CONNECTIONS_PER_USER = 5;
/** Drop a socket that has this many bytes waiting to be sent: the client is not reading. */
const MAX_BUFFERED_BYTES = 1_000_000;
const HEARTBEAT_MS = 25_000;
const SHUTDOWN_GRACE_MS = 500;

interface Connection {
  readonly socket: WebSocket;
  readonly userId: string;
  readonly sessionId: string;
  readonly accessExpiresAt: Date;
  audience: RealtimeAudience;
  alive: boolean;
}

/**
 * Who may listen, and what they hear: staff hear everything, a developer the same without ticket
 * subjects (T-137), a client only their organization.
 */
export function audienceFor(principal: Principal): RealtimeAudience | null {
  if (principal.orgScope.kind === 'org') {
    return principal.permissions.has('ticket.read.org')
      ? { kind: 'client', orgId: principal.orgScope.orgId }
      : null;
  }
  if (principal.permissions.has('ticket.read')) return { kind: 'staff', userId: principal.userId };
  return principal.permissions.has('ticket.read.masked')
    ? { kind: 'dev', userId: principal.userId }
    : null;
}

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * WebSocket endpoint `/v1/realtime` (PRD section 8.3: updates in under 2 seconds).
 *
 * It is not a Nest controller, so the global route guard never sees it and it has to enforce the
 * same rules itself, on the HTTP upgrade request before any socket exists:
 *  1. `Origin` must be the web app (APP_URL). A browser always sends it on a WebSocket handshake;
 *     a missing or foreign one is refused. This is what stops another site from opening a socket
 *     with the visitor's cookie (cross-site WebSocket hijacking).
 *  2. The `wt_at` cookie must hold a valid access JWT, and its session must be live and its user
 *     active in the database (the same checks as AuthGuard).
 *  3. The caller must be allowed to read tickets (`ticket.read` for staff, `ticket.read.masked` for a
 *     developer, `ticket.read.org` for a client).
 *
 * After the handshake the session is checked against the database again every
 * REALTIME_REVALIDATE_SECONDS, and the socket is closed with 4401 when the session ended, the user
 * was disabled or the access token expired (the client refreshes and reconnects), or 4403 when the
 * permission is gone. Events come from Redis pub/sub and are filtered per listener by
 * `realtimeEventFor`, the single place that decides what a client may hear.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly connections = new Set<Connection>();
  private wss: WebSocketServer | undefined;
  private server: Server | undefined;
  private subscriber: Redis | undefined;
  private revalidateTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly allowedOrigin: string;

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.handleUpgrade(request, socket, head).catch((error: unknown) => {
      this.logger.error({ err: error }, 'realtime handshake failed');
      reject(socket, '500 Internal Server Error');
    });
  };

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(REALTIME_CHANNEL_NAME) private readonly channel: string,
  ) {
    this.allowedOrigin = new URL(config.APP_URL).origin;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
    this.server.on('upgrade', this.onUpgrade);

    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('error', (error: Error) => {
      this.logger.error({ err: error }, 'realtime subscriber error');
    });
    subscriber.on('message', (_channel: string, payload: string) => {
      this.fanOut(payload);
    });
    try {
      await subscriber.subscribe(this.channel);
    } catch (error) {
      // ioredis resubscribes on its own once Redis is back; sockets simply hear nothing until then.
      this.logger.error({ err: error }, 'realtime could not subscribe yet');
    }

    this.revalidateTimer = setInterval(() => {
      void this.revalidate();
    }, this.config.REALTIME_REVALIDATE_SECONDS * 1000);
    this.revalidateTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  /** Number of open sockets, for tests and metrics. */
  get connectionCount(): number {
    return this.connections.size;
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on('error', () => {
      socket.destroy();
    });
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (path !== REALTIME_PATH) {
      reject(socket, '404 Not Found');
      return;
    }
    if (request.headers.origin !== this.allowedOrigin) {
      this.logger.warn(
        { origin: (request.headers.origin ?? '').slice(0, 200) },
        'refused a WebSocket from a foreign or missing origin',
      );
      reject(socket, '403 Forbidden');
      return;
    }

    // A repeated access cookie is not ours (see readCookie): no credentials, so 401.
    const cookies = parseCookieHeader(request.headers.cookie);
    const accessName = cookieNames(this.config).access;
    const token = cookies.duplicates.has(accessName) ? undefined : cookies.values.get(accessName);
    const claims = token === undefined ? null : await this.tokens.verifyAccessToken(token);
    const live = claims === null ? null : await this.sessions.authenticate(claims);
    if (claims === null || live === null) {
      reject(socket, '401 Unauthorized');
      return;
    }
    const principal = await this.auth.principalFor(live.user, live.session, claims.expiresAt);
    const audience = audienceFor(principal);
    if (audience === null) {
      reject(socket, '403 Forbidden');
      return;
    }
    const wss = this.wss;
    if (wss === undefined) {
      reject(socket, '503 Service Unavailable');
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      this.accept(webSocket, principal, audience, claims.expiresAt);
    });
  }

  private accept(
    socket: WebSocket,
    principal: Principal,
    audience: RealtimeAudience,
    accessExpiresAt: Date,
  ): void {
    const mine = [...this.connections].filter(
      (connection) => connection.userId === principal.userId,
    );
    if (mine.length >= MAX_CONNECTIONS_PER_USER) {
      mine[0]?.socket.close(REALTIME_CLOSE_CODES.tooManyConnections, 'too_many_connections');
    }

    const connection: Connection = {
      socket,
      userId: principal.userId,
      sessionId: principal.sessionId,
      accessExpiresAt,
      audience,
      alive: true,
    };
    this.connections.add(connection);
    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', () => {
      // Nothing is accepted from a client; this is a one-way feed.
      socket.close(1008, 'client_messages_not_accepted');
    });
    socket.on('error', () => {
      socket.terminate();
    });
    socket.on('close', () => {
      this.connections.delete(connection);
    });
    socket.send(
      JSON.stringify({
        type: 'ready',
        audience: audience.kind,
        accessExpiresAt: accessExpiresAt.toISOString(),
      }),
    );
  }

  private fanOut(payload: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.logger.warn('realtime: dropped a message that is not JSON');
      return;
    }
    const event = realtimeEventSchema.safeParse(parsed);
    if (!event.success) {
      this.logger.warn('realtime: dropped a message that is not a realtime event');
      return;
    }
    for (const connection of this.connections) {
      const visible = realtimeEventFor(connection.audience, event.data);
      if (visible === null || connection.socket.readyState !== WebSocket.OPEN) continue;
      if (connection.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        connection.socket.terminate();
        continue;
      }
      connection.socket.send(JSON.stringify(visible));
    }
  }

  /** Ends sockets whose token expired and re-checks each live session in the database. */
  private async revalidate(): Promise<void> {
    try {
      const now = Date.now();
      const bySession = new Map<string, Connection[]>();
      for (const connection of this.connections) {
        if (connection.accessExpiresAt.getTime() <= now) {
          connection.socket.close(REALTIME_CLOSE_CODES.unauthenticated, 'access_token_expired');
          continue;
        }
        const group = bySession.get(connection.sessionId) ?? [];
        group.push(connection);
        bySession.set(connection.sessionId, group);
      }
      for (const [sessionId, group] of bySession) {
        const first = group[0];
        if (first === undefined) continue;
        const live = await this.sessions.authenticate({ userId: first.userId, sessionId });
        if (live === null) {
          for (const connection of group) {
            connection.socket.close(REALTIME_CLOSE_CODES.unauthenticated, 'session_ended');
          }
          continue;
        }
        const principal = await this.auth.principalFor(
          live.user,
          live.session,
          first.accessExpiresAt,
        );
        const audience = audienceFor(principal);
        for (const connection of group) {
          if (audience === null) {
            connection.socket.close(REALTIME_CLOSE_CODES.forbidden, 'permission_removed');
          } else {
            connection.audience = audience;
          }
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, 'realtime revalidation failed');
    }
  }

  private heartbeat(): void {
    for (const connection of this.connections) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.revalidateTimer) clearInterval(this.revalidateTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.server?.off('upgrade', this.onUpgrade);
    for (const connection of this.connections) {
      connection.socket.close(1001, 'server_shutting_down');
      setTimeout(() => {
        connection.socket.terminate();
      }, SHUTDOWN_GRACE_MS).unref();
    }
    this.wss?.close();
    const subscriber = this.subscriber;
    if (subscriber) {
      await subscriber.quit().catch(() => {
        subscriber.disconnect();
      });
    }
  }
}
