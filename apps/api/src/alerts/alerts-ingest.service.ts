import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { alerts } from '@watchtower/connectors';
import type { CredentialStore, Database } from '@watchtower/db';
import type { Domain, IngestAlertOutcome } from '@watchtower/domain';
import {
  alertPubsubEnvelopeSchema,
  type AlertIngestResult,
  type NormalizedAlert,
} from '@watchtower/shared';

import { RateLimitedError, badRequest, unauthenticated } from '../auth/http-errors.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CREDENTIAL_STORE } from '../credentials/credentials.service.js';
import { DATABASE } from '../database/database.module.js';
import { translating } from '../domain/domain-errors.js';
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

  private async rateLimit(ip: string | null): Promise<void> {
    const hit = await this.limiter.hit(
      'alert-ingest-ip',
      ip ?? 'unknown',
      this.config.ALERT_INGEST_RATE_PER_MINUTE,
      MINUTE,
    );
    if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);
  }

  private async ingestOne(alert: NormalizedAlert, ip: string | null): Promise<IngestAlertOutcome> {
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
    await this.rateLimit(input.ip);

    const match = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(input.authorization ?? '');
    if (match?.[1] === undefined) throw unauthenticated('Authentication is required');
    try {
      await this.verifier.verify(match[1]);
    } catch (error) {
      if (error instanceof PushKeysUnavailableError) {
        this.logger.error('alerts gcp push: verification keys unavailable, answering 503 to retry');
        throw serviceUnavailable();
      }
      if (!(error instanceof PushAuthError)) throw error;
      this.logger.warn('alerts gcp push: token rejected');
      throw unauthenticated('Authentication is required');
    }

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
    const outcome = await this.ingestOne(normalized.alert, input.ip);
    return tally([outcome.kind]);
  }

  /** The signing secret in effect, or null when none is set. Read on every request so a rotation needs no restart. */
  private async webhookSecret(): Promise<string | null> {
    const fields = await this.credentials.resolve('alerting');
    const secret = fields.webhookSecret?.value ?? '';
    return secret === '' ? null : secret;
  }

  /**
   * Authenticates a signed body with the alerting secret (shared by the alert webhook and the heartbeat
   * route). Throws 401 with one answer for "no secret", "bad header", "wrong signature" and "too old":
   * a caller learns nothing about which. The verdict (a code) goes to the log, never the header or body.
   */
  private async authenticateSigned(
    route: string,
    input: { rawBody: Buffer | undefined; signature: string | undefined; nowMs?: number },
  ): Promise<Buffer> {
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
      if (secret === null) this.logger.warn(route + ': received but no signing secret is set');
      else this.logger.warn({ verdict }, route + ': signature rejected');
      throw unauthenticated('The request signature is missing or does not match');
    }
    return input.rawBody;
  }

  /** `POST /v1/inbound/alerts/webhook`: an Alertmanager-compatible payload signed with HMAC-SHA256. */
  async acceptWebhook(input: {
    readonly rawBody: Buffer | undefined;
    readonly signature: string | undefined;
    readonly ip: string | null;
    /** Epoch milliseconds, injected by tests; the process clock otherwise. */
    readonly nowMs?: number;
  }): Promise<AlertIngestResult> {
    await this.rateLimit(input.ip);
    const rawBody = await this.authenticateSigned('alerts webhook', input);

    const batch = alerts.normalizeAlertmanager(rawBody.toString('utf8'));
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
      outcomes.push((await this.ingestOne(result.alert, input.ip)).kind);
    }
    return tally(outcomes, ignored);
  }

  /**
   * `POST /v1/inbound/heartbeats/:slug`: a heartbeat signal (R-3.10), signed like the alert webhook. The
   * body is not read beyond the signature (send `{}`). An unknown slug is 404 only after the signature
   * checked out, so the route does not tell an anonymous caller which heartbeats exist.
   */
  async acceptHeartbeat(input: {
    readonly slug: string;
    readonly rawBody: Buffer | undefined;
    readonly signature: string | undefined;
    readonly ip: string | null;
    readonly nowMs?: number;
  }): Promise<{ recovered: boolean }> {
    await this.rateLimit(input.ip);
    await this.authenticateSigned('heartbeat', input);
    const ctx = this.domain.context({
      actor: { type: 'system', id: null },
      auditMeta: { ip: input.ip, requestId: null },
    });
    return translating(async () => {
      const result = await this.database.db.transaction((tx) =>
        this.domain.alerts.recordHeartbeat(tx, ctx, { slug: input.slug }),
      );
      return result.value;
    });
  }
}
