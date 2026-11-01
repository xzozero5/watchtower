import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { alerts } from '@watchtower/connectors';
import type { CredentialStore, Database } from '@watchtower/db';
import { isDomainError, type Domain, type IngestAlertOutcome } from '@watchtower/domain';
import {
  ALERT_WEBHOOK_MIN_SECRET_LENGTH as MIN_WEBHOOK_SECRET_LENGTH,
  alertPubsubEnvelopeSchema,
  type AlertIngestResult,
  type NormalizedAlert,
} from '@watchtower/shared';

import { RateLimitedError, badRequest, unauthenticated } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { DOMAIN } from '../domain/domain.module.js';
import {
  PushAuthError,
  PushKeysUnavailableError,
  type PushTokenVerifier,
} from '../gmail/push-verifier.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';

/** DI token of the Pub/Sub push verifier for alerts; `null` when it is not configured (answer 503). */
export const ALERT_PUSH_VERIFIER = Symbol('ALERT_PUSH_VERIFIER');

const MINUTE = 60;
/**
 * Failed authentications per minute from one address before it is answered 429 without any work.
 * Counted only when authentication fails, in a bucket of its own: real deliveries never use it up.
 * `[ASSUMED]` Behind a proxy with the wrong `TRUST_PROXY_HOPS` every caller looks like one address;
 * fix the hops, this limit is only there to bound what forged requests cost.
 */
const BAD_AUTH_LIMIT = 30;

const serviceUnavailable = (): HttpException =>
  new HttpException(
    { statusCode: 503, error: 'Service Unavailable' },
    HttpStatus.SERVICE_UNAVAILABLE,
  );

function tally(
  outcomes: readonly IngestAlertOutcome['kind'][],
  extraIgnored = 0,
): AlertIngestResult {
  let accepted = 0;
  let duplicates = 0;
  let ignored = extraIgnored;
  for (const kind of outcomes) {
    if (kind === 'duplicate') duplicates += 1;
    else if (kind === 'ignored') ignored += 1;
    else accepted += 1;
  }
  return { accepted, duplicates, ignored };
}

/**
 * The two alert receivers (T-201c, ADR-015 section 2): Pub/Sub push for GCP alert notifications and a
 * signed webhook for Alertmanager-compatible payloads. Thin on purpose: authenticate, normalize with the
 * connectors, hand each alert to `domain.alerts.ingest` (one transaction per alert), answer with counts.
 * Nothing here calls a provider.
 *
 * Order matters on both routes: rate limit (cheap, before any crypto) -> authenticate -> only then
 * read the body. A request that fails authentication writes nothing and logs no body, token, signature
 * or secret.
 *
 * What is acknowledged (2xx) and what is not follows Pub/Sub's rules (2xx ack, anything else redelivers):
 *   - bad or missing token or signature: 401, nothing written;
 *   - keys unavailable / database down: 5xx, the sender retries;
 *   - an authentic message we can never use (unreadable payload, unknown shape): 2xx and counted as
 *     `ignored`, otherwise Pub/Sub would redeliver it forever.
 */
@Injectable()
export class AlertIngestService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(ALERT_PUSH_VERIFIER) private readonly verifier: PushTokenVerifier | null,
    @Inject(CREDENTIAL_STORE) private readonly credentials: CredentialStore,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** First thing on a route: an address that keeps failing authentication costs a Redis read and nothing else. */
  private async refuseFailingAddress(ip: string | null): Promise<void> {
    const standing = await this.limiter.blocked('alert-bad-auth', ip ?? 'unknown', BAD_AUTH_LIMIT);
    if (standing.blocked) throw new RateLimitedError(standing.retryAfterSeconds);
  }

  /** Counts a failed authentication against the address, then answers 401 like any other failure. */
  private async authenticationFailed(ip: string | null, message: string): Promise<never> {
    await this.limiter.hit('alert-bad-auth', ip ?? 'unknown', BAD_AUTH_LIMIT, MINUTE);
    throw unauthenticated(message);
  }

  /**
   * After authentication: the budget of one verified source (the Pub/Sub service account, the webhook
   * secret), not of an address. Forged requests cannot use it up, and a proxy that hides the real
   * address cannot make real alerts share a bucket with strangers.
   */
  private async limitSource(source: string): Promise<void> {
    const hit = await this.limiter.hit(
      'alert-ingest-source',
      source,
      this.config.ALERT_INGEST_RATE_PER_MINUTE,
      MINUTE,
    );
    if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);
  }

  /**
   * One alert through the domain. A delivery the domain refuses as invalid (`bad_request`) will be
   * refused every time, so it is logged by code and acknowledged as `ignored`; Pub/Sub would otherwise
   * redeliver it forever. Anything else (the database is down) propagates and the sender retries.
   */
  private async ingestOne(
    alert: NormalizedAlert,
    ip: string | null,
  ): Promise<IngestAlertOutcome['kind']> {
    try {
      return (await this.applyOne(alert, ip)).kind;
    } catch (error) {
      if (isDomainError(error) && error.code === 'bad_request') {
        this.logger.warn(
          { source: alert.source },
          'alerts: a delivery the domain refuses as invalid was dropped, not retried',
        );
        return 'ignored';
      }
      throw error;
    }
  }

  private async applyOne(alert: NormalizedAlert, ip: string | null): Promise<IngestAlertOutcome> {
    const ctx = this.domain.context({
      actor: { type: 'system', id: null },
      auditMeta: { ip, requestId: null },
    });
    const result = await this.database.db.transaction((tx) =>
      this.domain.alerts.ingest(tx, ctx, { alert }),
    );
    return result.value;
  }

  /** `POST /v1/inbound/alerts/gcp`: a Pub/Sub push of a Cloud Monitoring notification. */
  async acceptGcp(input: {
    readonly authorization: string | undefined;
    readonly body: unknown;
    readonly ip: string | null;
  }): Promise<AlertIngestResult> {
    if (this.verifier === null) {
      this.logger.warn(
        'alerts gcp push: not configured (ALERT_PUSH_AUDIENCE / ALERT_PUSH_SERVICE_ACCOUNT)',
      );
      throw serviceUnavailable();
    }
    await this.refuseFailingAddress(input.ip);

    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(input.authorization ?? '');
    if (match?.[1] === undefined) {
      return this.authenticationFailed(input.ip, 'Authentication is required');
    }
    let identity;
    try {
      identity = await this.verifier.verify(match[1]);
    } catch (error) {
      if (error instanceof PushKeysUnavailableError) {
        this.logger.error('alerts gcp push: verification keys unavailable, answering 503 to retry');
        throw serviceUnavailable();
      }
      if (!(error instanceof PushAuthError)) throw error;
      this.logger.warn('alerts gcp push: token rejected');
      return this.authenticationFailed(input.ip, 'Authentication is required');
    }
    await this.limitSource(`gcp:${identity.email}`);

    const envelope = alertPubsubEnvelopeSchema.safeParse(input.body);
    if (!envelope.success) {
      this.logger.warn('alerts gcp push: authentic message with an unreadable envelope, dropped');
      return tally([], 1);
    }
    const normalized = alerts.normalizeGcpAlert(
      alerts.decodePubsubText(envelope.data.message.data),
      {
        messageId: envelope.data.message.messageId,
      },
    );
    if (!normalized.ok) {
      this.logger.warn(
        { reason: normalized.reason },
        'alerts gcp push: authentic message that is not an alert notification, dropped',
      );
      return tally([], 1);
    }
    return tally([await this.ingestOne(normalized.alert, input.ip)]);
  }

  /** The signing secret in effect, or null when none is set. Read on every request so a rotation needs no restart. */
  private async webhookSecret(): Promise<string | null> {
    const fields = await this.credentials.resolve('alerting');
    const secret = fields.webhookSecret?.value ?? '';
    if (secret === '') return null;
    if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
      // A short secret is as good as none: refuse rather than accept signatures that can be guessed.
      this.logger.warn('alerts webhook: the signing secret is shorter than the minimum, refusing');
      return null;
    }
    return secret;
  }

  /** `POST /v1/inbound/alerts/webhook`: an Alertmanager-compatible payload signed with HMAC-SHA256. */
  async acceptWebhook(input: {
    readonly rawBody: Buffer | undefined;
    readonly signature: string | undefined;
    readonly ip: string | null;
    /** Epoch milliseconds, injected by tests; the process clock otherwise. */
    readonly nowMs?: number;
  }): Promise<AlertIngestResult> {
    await this.refuseFailingAddress(input.ip);
    const secret = await this.webhookSecret();
    const verdict =
      secret === null || input.rawBody === undefined
        ? 'malformed'
        : alerts.verifyAlertWebhook({
            rawBody: input.rawBody,
            header: input.signature,
            secret,
            nowMs: input.nowMs ?? Date.now(),
          });
    if (verdict !== 'ok' || input.rawBody === undefined) {
      // One answer for "no secret", "bad header", "wrong signature" and "too old": a caller learns
      // nothing about which. The verdict (a code) goes to the log, never the header or the body.
      if (secret === null)
        this.logger.warn('alerts webhook: received but no signing secret is set');
      else this.logger.warn({ verdict }, 'alerts webhook: signature rejected');
      return this.authenticationFailed(
        input.ip,
        'The request signature is missing or does not match',
      );
    }
    await this.limitSource('webhook');

    const batch = alerts.normalizeAlertmanager(input.rawBody.toString('utf8'));
    if (typeof batch === 'string') {
      throw badRequest('The body is not an Alertmanager webhook payload');
    }
    const outcomes: IngestAlertOutcome['kind'][] = [];
    let ignored = batch.truncated;
    for (const result of batch.results) {
      if (!result.ok) {
        ignored += 1;
        continue;
      }
      outcomes.push(await this.ingestOne(result.alert, input.ip));
    }
    return tally(outcomes, ignored);
  }
}
