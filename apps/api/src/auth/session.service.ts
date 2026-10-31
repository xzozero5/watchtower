import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { AuthMethod, Device } from '@watchtower/shared';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  TokenService,
  type AccessClaims,
} from './token.service.js';

type UserRow = typeof schema.users.$inferSelect;
type SessionRow = typeof schema.sessions.$inferSelect;

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
  readonly csrfToken: string;
}

export type RefreshFailure =
  | 'unknown'
  | 'expired'
  | 'session_ended'
  | 'user_disabled'
  /** A refresh token that was already exchanged came back: the session is revoked. */
  | 'reuse';

export type RefreshResult =
  | {
      readonly ok: true;
      readonly user: UserRow;
      readonly authMethod: AuthMethod;
      readonly session: IssuedSession;
    }
  | {
      readonly ok: false;
      readonly reason: RefreshFailure;
      readonly userId?: string;
      readonly sessionId?: string;
    };

const MAX_USER_AGENT = 300;

export function clipUserAgent(value: string | undefined): string | null {
  return value ? value.slice(0, MAX_USER_AGENT) : null;
}

/**
 * Sessions and refresh-token rotation.
 *
 * A session is one signed-in device. It owns a chain of refresh tokens: each is used once, to
 * obtain the next one and a fresh access JWT. Only SHA-256 hashes are stored. If a token that was
 * already used is presented again, someone holds a copy (a stolen cookie, or a stale client), and
 * the whole session is revoked: the thief and the owner both have to sign in again. Browsers must
 * therefore refresh from one place at a time (T-006 single-flights it).
 *
 * The access JWT only says who and which session; every request re-reads the session and the user,
 * so a forced logout, a disabled account or a role change takes effect on the next request.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  async issue(user: UserRow, method: AuthMethod, meta: RequestMeta): Promise<IssuedSession> {
    const now = Date.now();
    const sessionExpiresAt = new Date(now + this.config.SESSION_MAX_AGE_SECONDS * 1000);
    const refresh = generateOpaqueToken();
    const refreshExpiresAt = new Date(
      Math.min(now + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000, sessionExpiresAt.getTime()),
    );

    const sessionId = await this.database.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(schema.sessions)
        .values({
          userId: user.id,
          authMethod: method,
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt: sessionExpiresAt,
        })
        .returning({ id: schema.sessions.id });
      if (!session) throw new Error('session insert returned no row');
      await tx.insert(schema.refreshTokens).values({
        sessionId: session.id,
        tokenHash: hashOpaqueToken(refresh),
        expiresAt: refreshExpiresAt,
      });
      await tx
        .update(schema.users)
        .set({ lastLoginAt: new Date(now), updatedAt: new Date(now) })
        .where(eq(schema.users.id, user.id));
      return session.id;
    });

    const access = await this.tokens.signAccessToken({ userId: user.id, sessionId });
    return {
      sessionId,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken: refresh,
      refreshExpiresAt,
      csrfToken: this.tokens.csrfTokenFor(sessionId),
    };
  }

  /** The live session and user behind a verified access token, or null (revoked, expired, disabled). */
  async authenticate(claims: AccessClaims): Promise<{ user: UserRow; session: SessionRow } | null> {
    const [row] = await this.database.db
      .select({ user: schema.users, session: schema.sessions })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(
        and(
          eq(schema.sessions.id, claims.sessionId),
          eq(schema.sessions.userId, claims.userId),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, sql`now()`),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async refresh(plainToken: string, meta: RequestMeta): Promise<RefreshResult> {
    const hash = hashOpaqueToken(plainToken);
    const now = new Date();
    const next = generateOpaqueToken();

    // One transaction. It returns a verdict instead of throwing, so a "reuse" verdict commits the
    // revocation it wrote.
    const outcome = await this.database.db.transaction(async (tx): Promise<RefreshResult> => {
      // Lock the token row: two concurrent refreshes with the same token are serialized, and
      // the second one sees the token as used, which is a replay.
      const [token] = await tx
        .select()
        .from(schema.refreshTokens)
        .where(eq(schema.refreshTokens.tokenHash, hash))
        .for('update');
      if (!token) return { ok: false, reason: 'unknown' };

      const [row] = await tx
        .select({ user: schema.users, session: schema.sessions })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .where(eq(schema.sessions.id, token.sessionId))
        .for('update', { of: schema.sessions });
      if (!row) return { ok: false, reason: 'unknown' };
      const { user, session } = row;
      const identity = { userId: user.id, sessionId: session.id };

      if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'session_ended', ...identity };
      }
      if (token.usedAt !== null) {
        await tx
          .update(schema.sessions)
          .set({ revokedAt: now, revokedReason: 'refresh_reuse' })
          .where(eq(schema.sessions.id, session.id));
        return { ok: false, reason: 'reuse', ...identity };
      }
      if (token.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired', ...identity };
      }
      if (user.status !== 'active') return { ok: false, reason: 'user_disabled', ...identity };

      const refreshExpiresAt = new Date(
        Math.min(
          now.getTime() + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000,
          session.expiresAt.getTime(),
        ),
      );
      const [created] = await tx
        .insert(schema.refreshTokens)
        .values({
          sessionId: session.id,
          tokenHash: hashOpaqueToken(next),
          expiresAt: refreshExpiresAt,
        })
        .returning({ id: schema.refreshTokens.id });
      if (!created) throw new Error('refresh token insert returned no row');
      await tx
        .update(schema.refreshTokens)
        .set({ usedAt: now, replacedBy: created.id })
        .where(eq(schema.refreshTokens.id, token.id));
      await tx
        .update(schema.sessions)
        .set({ lastUsedAt: now, ip: meta.ip, userAgent: meta.userAgent })
        .where(eq(schema.sessions.id, session.id));
      return {
        ok: true,
        user,
        authMethod: session.authMethod as AuthMethod,
        session: {
          sessionId: session.id,
          accessToken: '',
          accessExpiresAt: now,
          refreshToken: next,
          refreshExpiresAt,
          csrfToken: this.tokens.csrfTokenFor(session.id),
        },
      };
    });
    if (!outcome.ok) return outcome;

    const access = await this.tokens.signAccessToken({
      userId: outcome.user.id,
      sessionId: outcome.session.sessionId,
    });
    return {
      ok: true,
      user: outcome.user,
      authMethod: outcome.authMethod,
      session: { ...outcome.session, accessToken: access.token, accessExpiresAt: access.expiresAt },
    };
  }

  /** Revokes one session. With `userId`, only if it belongs to that user. Returns whether it was live. */
  async revoke(sessionId: string, reason: string, userId?: string): Promise<boolean> {
    const rows = await this.database.db
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(schema.sessions.id, sessionId),
          isNull(schema.sessions.revokedAt),
          userId === undefined ? undefined : eq(schema.sessions.userId, userId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const rows = await this.database.db
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(schema.sessions.userId, userId),
          isNull(schema.sessions.revokedAt),
          exceptSessionId === undefined ? undefined : ne(schema.sessions.id, exceptSessionId),
        ),
      )
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  /** The session a refresh token belongs to, for logout when the access cookie has expired. */
  async sessionIdForRefreshToken(plainToken: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ sessionId: schema.refreshTokens.sessionId })
      .from(schema.refreshTokens)
      .where(eq(schema.refreshTokens.tokenHash, hashOpaqueToken(plainToken)))
      .limit(1);
    return row?.sessionId ?? null;
  }

  async listDevices(userId: string, currentSessionId: string): Promise<Device[]> {
    const rows = await this.database.db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, userId),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, sql`now()`),
        ),
      )
      .orderBy(sql`${schema.sessions.lastUsedAt} DESC`);
    return rows.map((row) => ({
      id: row.id,
      authMethod: row.authMethod as AuthMethod,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      current: row.id === currentSessionId,
    }));
  }

  async sessionOwner(sessionId: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ userId: schema.sessions.userId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1);
    return row?.userId ?? null;
  }
}
