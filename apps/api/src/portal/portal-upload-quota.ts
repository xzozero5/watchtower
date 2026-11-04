import { createHash } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import type { Redis } from 'ioredis';

import { AuditScope } from '../audit/audit-scope.js';
import { ApiHttpError } from '../auth/http-errors.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { DOMAIN, type Domain } from '../domain/domain.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { RealtimePublisher } from '../realtime/realtime-publisher.js';
import { REDIS } from '../redis/redis.module.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';

const DAY_SECONDS = 24 * 3600;
const MB = 1024 * 1024;
/** The alert for a full instance-wide cap is raised at most this often. */
const ALERT_EVERY_SECONDS = 3600;

export type QuotaScope = 'ip' | 'email' | 'org' | 'global';

/** Who is uploading. A missing subject is not counted at that scope (the global cap still is). */
export interface QuotaSubjects {
  readonly ip: string | null;
  readonly email?: string | undefined;
  readonly org?: string | undefined;
}

/** Bytes held against the caps until the upload is saved; `refund` gives them back if it is not. */
export interface QuotaReservation {
  refund(): Promise<void>;
}

const NOTHING_RESERVED: QuotaReservation = { refund: () => Promise.resolve() };

// Checks every cap, and only if all of them have room adds the bytes to every counter: one atomic
// step, so two requests at once cannot both slip under the same cap (the old check summed the day's
// messages first and wrote them later). Returns 0, or the 1-based position of the first cap that is full.
const RESERVE = `
local bytes = tonumber(ARGV[1])
for i = 1, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used + bytes > tonumber(ARGV[2 + i]) then return i end
end
for i = 1, #KEYS do
  local total = redis.call('INCRBY', KEYS[i], bytes)
  if total == bytes or redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], ARGV[2]) end
end
return 0
`;

const REFUND = `
local bytes = tonumber(ARGV[1])
for i = 1, #KEYS do
  local total = redis.call('DECRBY', KEYS[i], bytes)
  if total < 0 then redis.call('SET', KEYS[i], 0, 'KEEPTTL') end
end
return 1
`;

/**
 * What customers may upload through the portal in 24 hours (T-155a C-1, security review T-155 P2):
 * a cap per client address, per email address and per organization, and the instance-wide cap
 * (`PORTAL_UPLOAD_DAILY_MB`) as a backstop. One outsider fills only their own buckets, so they
 * cannot keep every customer from attaching files for a day, which the single instance-wide cap
 * allowed. Counters are Redis `INCRBY`s changed in one Lua step (atomic across the caps); the
 * windows are fixed 24 hours from the first upload counted. A crash between reserving and saving
 * leaves bytes counted that were not stored: the error is on the side of refusing.
 *
 * Hitting the instance-wide cap is audited, logged at error level (once an hour) and counted
 * (`portal_upload_quota_global_total`) for an alert, because it means a real attack or a real need to
 * raise the cap. If Redis is down this rejects, like the other portal limits (fail closed).
 */
@Injectable()
export class PortalUploadQuota {
  private readonly caps: Readonly<Record<QuotaScope, number>>;
  private readonly namespace: string;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG)
    config: Pick<
      ApiConfig,
      | 'RATE_LIMIT_NAMESPACE'
      | 'PORTAL_UPLOAD_DAILY_MB'
      | 'PORTAL_UPLOAD_IP_DAILY_MB'
      | 'PORTAL_UPLOAD_EMAIL_DAILY_MB'
      | 'PORTAL_UPLOAD_ORG_DAILY_MB'
    >,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(TelemetryService) private readonly telemetry: TelemetryService,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(DOMAIN) private readonly domain: Domain,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
  ) {
    this.namespace = config.RATE_LIMIT_NAMESPACE;
    this.caps = {
      ip: config.PORTAL_UPLOAD_IP_DAILY_MB * MB,
      email: config.PORTAL_UPLOAD_EMAIL_DAILY_MB * MB,
      org: config.PORTAL_UPLOAD_ORG_DAILY_MB * MB,
      global: config.PORTAL_UPLOAD_DAILY_MB * MB,
    };
  }

  private key(scope: QuotaScope, subject: string): string {
    const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32);
    return `${this.namespace}:uq:${scope}:${digest}`;
  }

  /** The counters that apply to these subjects, with their caps. Scopes with no cap (0) are left out. */
  private plan(subjects: QuotaSubjects): { scope: QuotaScope; key: string; cap: number }[] {
    const wanted: [QuotaScope, string | null | undefined][] = [
      ['ip', subjects.ip],
      ['email', subjects.email?.toLowerCase()],
      ['org', subjects.org],
      ['global', 'instance'],
    ];
    return wanted.flatMap(([scope, subject]) =>
      subject === null || subject === undefined || this.caps[scope] === 0
        ? []
        : [{ scope, key: this.key(scope, subject), cap: this.caps[scope] }],
    );
  }

  /**
   * Counts `bytes` against every cap that applies, or throws 429 `upload_quota` naming (in the audit
   * row, not to the caller) the scope that is full.
   */
  async reserve(bytes: number, subjects: QuotaSubjects): Promise<QuotaReservation> {
    if (bytes <= 0) return NOTHING_RESERVED;
    const plan = this.plan(subjects);
    if (plan.length === 0) return NOTHING_RESERVED;
    const full = (await this.redis.eval(
      RESERVE,
      plan.length,
      ...plan.map((entry) => entry.key),
      String(bytes),
      String(DAY_SECONDS),
      ...plan.map((entry) => String(entry.cap)),
    )) as number;
    if (full !== 0) {
      const scope = plan[full - 1]?.scope ?? 'global';
      if (scope === 'global') await this.raiseGlobalAlert();
      AuditScope.set({
        action: AUDIT_ACTIONS.portalAttachmentRejected,
        outcome: 'denied',
        metadata: { reason: scope === 'global' ? 'upload_quota_global' : 'upload_quota', scope },
      });
      throw new ApiHttpError(
        HttpStatus.TOO_MANY_REQUESTS,
        'upload_quota',
        'File uploads are paused for you today; send your message without files or try again tomorrow',
      );
    }
    let refunded = false;
    return {
      refund: async () => {
        if (refunded) return;
        refunded = true;
        try {
          await this.redis.eval(
            REFUND,
            plan.length,
            ...plan.map((entry) => entry.key),
            String(bytes),
          );
        } catch (error) {
          // The bytes stay counted until the window ends: refusing too much, never too little.
          this.logger.warn({ err: error }, 'portal upload quota could not be refunded');
        }
      },
    };
  }

  private async raiseGlobalAlert(): Promise<void> {
    this.telemetry.count('upload_quota_global');
    const first = await this.redis.set(
      `${this.namespace}:uq:alerted`,
      '1',
      'EX',
      ALERT_EVERY_SECONDS,
      'NX',
    );
    if (first === 'OK') {
      this.logger.error(
        { cap: 'PORTAL_UPLOAD_DAILY_MB', alert: 'portal_upload_quota_global' },
        'the instance-wide daily cap on portal uploads is reached: customers cannot attach files until it resets; ' +
          'look for one source in the audit log (portal.attachment_rejected, reason upload_quota_global) or raise the cap',
      );
      await this.tellHeads();
    }
  }

  /** The heads hear about it in the app (T-176). Never lets a failure here change the 429 the caller gets. */
  private async tellHeads(): Promise<void> {
    try {
      const notice = await this.domain.notifications.opsAlert(
        this.database.db,
        this.domain.context({ actor: { type: 'system', id: null } }),
        { kind: 'ops.upload_quota_global', data: { capMb: this.caps.global / MB } },
      );
      for (const event of notice.events) await this.publisher.publish(event);
    } catch (error) {
      this.logger.warn({ err: error }, 'portal upload quota: the heads could not be notified');
    }
  }
}
