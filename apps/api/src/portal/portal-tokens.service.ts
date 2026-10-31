import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import type { DbTransaction } from '../realtime/unit-of-work.js';
import { PORTAL_KEY_LABELS, derivePortalKey } from './portal-keys.js';
import { hashToken, mintToken, verifyToken } from './portal-tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrackingAccess {
  readonly ticketId: string;
  readonly contactId: string;
  readonly expiresAt: Date;
}

/**
 * Issues, checks and revokes the tracking links of the portal. Every email that carries a link
 * carries a fresh token, so the period starts again (PORTAL_TOKEN_TTL_DAYS); older tokens keep
 * working until they expire or staff revoke them. Only a hash is stored.
 */
@Injectable()
export class PortalTokensService {
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE) private readonly database: Database,
  ) {
    this.key = derivePortalKey(config, PORTAL_KEY_LABELS.trackingToken);
  }

  /** Mints a token for `contactId` on `ticketId` inside the caller's transaction. */
  async issue(
    tx: DbTransaction,
    ticketId: string,
    contactId: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    const minted = mintToken(
      this.key,
      ticketId,
      new Date(now.getTime() + this.config.PORTAL_TOKEN_TTL_DAYS * DAY_MS),
    );
    // Housekeeping: a week after a link expired nobody can use it, so its row goes.
    await tx
      .delete(schema.portalAccessToken)
      .where(
        and(
          eq(schema.portalAccessToken.ticketId, ticketId),
          lt(schema.portalAccessToken.expiresAt, new Date(now.getTime() - 7 * DAY_MS)),
        ),
      );
    await tx.insert(schema.portalAccessToken).values({
      ticketId,
      contactId,
      tokenHash: hashToken(minted.token),
      expiresAt: minted.expiresAt,
    });
    return { token: minted.token, expiresAt: minted.expiresAt };
  }

  /**
   * The ticket and contact a token opens, or null for any reason it does not: malformed, forged,
   * expired, unknown, revoked. The database is asked even when the signature is already bad, so a
   * forged token and a revoked one cost the same time.
   */
  async authenticate(token: string | undefined): Promise<TrackingAccess | null> {
    const presented = token ?? '';
    const now = new Date();
    const claims = verifyToken(this.key, presented, now);
    const [row] = await this.database.db
      .select({
        ticketId: schema.portalAccessToken.ticketId,
        contactId: schema.portalAccessToken.contactId,
        expiresAt: schema.portalAccessToken.expiresAt,
      })
      .from(schema.portalAccessToken)
      .where(
        and(
          eq(schema.portalAccessToken.tokenHash, hashToken(presented)),
          isNull(schema.portalAccessToken.revokedAt),
          gt(schema.portalAccessToken.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!claims || !row || row.ticketId !== claims.ticketId) return null;
    return { ticketId: row.ticketId, contactId: row.contactId, expiresAt: row.expiresAt };
  }

  /** Revokes every live link of a ticket. Returns how many were live. */
  async revokeForTicket(tx: DbTransaction, ticketId: string): Promise<number> {
    const revoked = await tx
      .update(schema.portalAccessToken)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(schema.portalAccessToken.ticketId, ticketId),
          isNull(schema.portalAccessToken.revokedAt),
          gt(schema.portalAccessToken.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: schema.portalAccessToken.id });
    return revoked.length;
  }
}
