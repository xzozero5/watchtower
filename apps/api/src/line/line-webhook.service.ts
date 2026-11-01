import { Inject, Injectable } from '@nestjs/common';
import { line } from '@watchtower/channels';
import { schema, type CredentialStore, type Database } from '@watchtower/db';
import type { Domain } from '@watchtower/domain';
import { INBOUND_QUEUES, INGEST_JOBS, INGEST_OUTBOX_JOB_OPTIONS } from '@watchtower/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { RateLimitedError, badRequest, unauthenticated } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { DOMAIN } from '../domain/domain.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/**
 * The LINE webhook receiver (T-103b, ADR-009 section 1, R-2.9). Thin on purpose: LINE wants a fast
 * 200, so the request verifies the signature, writes one `inbound_event` per event together with an
 * `ingest` outbox job in ONE transaction, and answers. Normalising, media, the ticket and the
 * acknowledgment are the worker's (`apps/worker/src/ingest`). Nothing here calls LINE.
 *
 * Order matters: the signature is checked against the exact bytes received (`req.rawBody`) before
 * the body is parsed or any row is written; a request that fails any check writes nothing and logs
 * no body, signature or secret. The channel secret is read from the credential store (environment
 * first, then the encrypted database, ADR-012) on every request, so a rotation needs no restart.
 */

/** LINE sends at most a few events per request; a bigger array is not LINE. `[ASSUMED]` */
const MAX_EVENTS_PER_REQUEST = 100;
/** Failed signatures from one address per minute before it is answered 429 (valid traffic never counts). */
const BAD_SIGNATURE_LIMIT = 30;
const BAD_SIGNATURE_WINDOW_SECONDS = 60;

export interface WebhookResult {
  /** Events stored and queued for the worker. */
  readonly accepted: number;
  /** Events LINE sent before (a redelivery, or a retry after a lost 200): ignored. */
  readonly duplicates: number;
  /** Events that do not fit the schema: counted, never stored. */
  readonly rejected: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class LineWebhookService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** The channel secret in effect, or null when the integration has none (not configured). */
  private async channelSecret(): Promise<string | null> {
    const fields = await this.credentials.resolve('line');
    const secret = fields.channelSecret?.value ?? '';
    return secret === '' ? null : secret;
  }

  async receive(input: {
    readonly channelAccountId: string;
    readonly rawBody: Buffer | undefined;
    readonly signature: string | undefined;
    readonly ip: string;
  }): Promise<WebhookResult> {
    // First, before any lookup, credential read or HMAC: an address that keeps failing the signature
    // costs a Redis read and nothing else. Only failures are counted (below), so LINE is never throttled.
    const standing = await this.limiter.blocked(
      'line-bad-signature',
      input.ip,
      BAD_SIGNATURE_LIMIT,
    );
    if (standing.blocked) throw new RateLimitedError(standing.retryAfterSeconds);
    const [account] = await this.database.db
      .select({ id: schema.channelAccount.id })
      .from(schema.channelAccount)
      .where(
        and(
          eq(schema.channelAccount.id, input.channelAccountId),
          eq(schema.channelAccount.type, 'line'),
          // A switched-off account answers like an unknown one (T-131).
          isNull(schema.channelAccount.disabledAt),
        ),
      )
      .limit(1);
    const secret = account === undefined ? null : await this.channelSecret();
    const valid =
      secret !== null &&
      input.rawBody !== undefined &&
      line.verifyLineSignature({
        rawBody: input.rawBody,
        signature: input.signature,
        channelSecret: secret,
      });
    if (!valid || account === undefined) {
      // One answer for "no such account", "no secret configured" and "wrong signature": a caller
      // learns nothing about which accounts exist. Only failures count against the rate limit.
      await this.limiter.enforce(
        'line-bad-signature',
        input.ip,
        BAD_SIGNATURE_LIMIT,
        BAD_SIGNATURE_WINDOW_SECONDS,
      );
      if (account !== undefined && secret === null) {
        this.logger.warn(
          { channelAccountId: account.id },
          'LINE webhook received but no channel secret is configured',
        );
      }
      throw unauthenticated('The request signature is missing or does not match');
    }

    const events = this.parse(input.rawBody);
    const tracked: { providerEventId: string; payload: Record<string, unknown> }[] = [];
    let rejected = 0;
    for (const raw of events) {
      const normalised = line.normalizeLineEvent(raw);
      if (typeof normalised === 'string' || !isRecord(raw)) {
        rejected += 1;
        continue;
      }
      tracked.push({ providerEventId: normalised.providerEventId, payload: raw });
    }

    let accepted = 0;
    if (tracked.length > 0) {
      accepted = await this.database.db.transaction(async (tx) => {
        let stored = 0;
        for (const event of tracked) {
          // A redelivery hits the unique key and writes nothing (ADR-009 section 1).
          const [row] = await tx
            .insert(schema.inboundEvent)
            .values({
              channelAccountId: account.id,
              providerEventId: event.providerEventId,
              payload: event.payload,
            })
            .onConflictDoNothing()
            .returning({ id: schema.inboundEvent.id });
          if (row === undefined) continue;
          await this.domain.outbox.enqueue(tx, this.domain.config, {
            queue: INBOUND_QUEUES.ingest,
            name: INGEST_JOBS.process,
            jobId: row.id,
            payload: { inboundEventId: row.id },
            options: INGEST_OUTBOX_JOB_OPTIONS,
          });
          stored += 1;
        }
        return stored;
      });
    }
    return { accepted, duplicates: tracked.length - accepted, rejected };
  }

  /** The `events` array of a body whose signature was already verified. */
  private parse(rawBody: Buffer): unknown[] {
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw badRequest('The body is not JSON');
    }
    if (!isRecord(json) || !Array.isArray(json.events)) {
      throw badRequest('The body has no events array');
    }
    if (json.events.length > MAX_EVENTS_PER_REQUEST) throw badRequest('Too many events');
    return json.events as unknown[];
  }
}
