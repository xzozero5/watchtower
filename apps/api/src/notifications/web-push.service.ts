import { Inject, Injectable } from '@nestjs/common';
import { webpush } from '@watchtower/channels';
import { schema, type CredentialStore, type Database } from '@watchtower/db';
import type { WebPushStatus, WebPushSubscribe } from '@watchtower/shared';
import { and, asc, count, eq } from 'drizzle-orm';

import { badRequest, conflict } from '../auth/http-errors.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';

/** A person's browsers and devices; past this the oldest is dropped, so a forgotten one cannot pile up. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;

/**
 * Web Push subscriptions of the caller (T-105). The endpoint is a capability URL of a push service: it is
 * checked against the allow-list when it is saved (an unknown host is refused, so a forged subscription cannot
 * aim the worker at an arbitrary URL), stored, and never returned or logged. Sending is the worker's job.
 */
@Injectable()
export class WebPushService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
  ) {}

  /** The VAPID public key when the `web_push` credential is complete and consistent, else null. */
  private async publicKey(): Promise<string | null> {
    const fields = await this.credentials.resolve('web_push');
    const publicKey = fields.vapidPublic?.value;
    const privateKey = fields.vapidPrivate?.value;
    const subject = fields.subject?.value;
    if (publicKey === undefined || privateKey === undefined || subject === undefined) return null;
    if (!webpush.vapidKeysMatch({ publicKey, privateKey })) return null;
    if (!webpush.isValidVapidSubject(subject)) return null;
    return publicKey;
  }

  async status(userId: string): Promise<WebPushStatus> {
    const publicKey = await this.publicKey();
    const [row] = await this.database.db
      .select({ value: count() })
      .from(schema.webPushSubscription)
      .where(eq(schema.webPushSubscription.userId, userId));
    return { enabled: publicKey !== null, publicKey, subscribed: row?.value ?? 0 };
  }

  async subscribe(userId: string, input: WebPushSubscribe): Promise<WebPushStatus> {
    if ((await this.publicKey()) === null) {
      throw conflict('Web Push is not set up on this server');
    }
    const checked = webpush.checkPushEndpoint(input.endpoint);
    if (!checked.ok) throw badRequest("This browser's push service is not supported");
    try {
      // Proves the keys are a real P-256 point and a 16-byte secret before anything is stored.
      webpush.encryptMessage({
        plaintext: new Uint8Array(1),
        uaPublic: webpush.b64urlDecode(input.keys.p256dh),
        authSecret: webpush.b64urlDecode(input.keys.auth),
      });
    } catch {
      throw badRequest('The push subscription keys are not valid');
    }
    const { webPushSubscription } = schema;
    await this.database.db.transaction(async (tx) => {
      // The same browser signing in as someone else becomes that person's: the endpoint is unique.
      await tx
        .insert(webPushSubscription)
        .values({
          userId,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
        })
        .onConflictDoUpdate({
          target: webPushSubscription.endpoint,
          set: {
            userId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            userAgent: input.userAgent ?? null,
            failureCount: 0,
          },
        });
      const mine = await tx
        .select({ id: webPushSubscription.id })
        .from(webPushSubscription)
        .where(eq(webPushSubscription.userId, userId))
        .orderBy(asc(webPushSubscription.createdAt), asc(webPushSubscription.id));
      for (const stale of mine.slice(0, Math.max(0, mine.length - MAX_SUBSCRIPTIONS_PER_USER))) {
        await tx.delete(webPushSubscription).where(eq(webPushSubscription.id, stale.id));
      }
    });
    return this.status(userId);
  }

  /** Removes the caller's subscription for this endpoint (idempotent: nothing to remove is fine). */
  async unsubscribe(userId: string, endpoint: string): Promise<WebPushStatus> {
    await this.database.db
      .delete(schema.webPushSubscription)
      .where(
        and(
          eq(schema.webPushSubscription.userId, userId),
          eq(schema.webPushSubscription.endpoint, endpoint),
        ),
      );
    return this.status(userId);
  }
}
