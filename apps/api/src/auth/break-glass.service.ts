import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import type { UserRow } from '../users/users.service.js';
import { provisionBreakGlass, type ProvisionResult } from './break-glass-provision.js';
import { ipBucket } from './ip-bucket.js';
import { invalidCredentials, RateLimitedError } from './http-errors.js';
import { PasswordService } from './password.service.js';
import { RateLimiter } from './rate-limiter.js';

/**
 * Wrong passwords from one client address before that address is locked out of the account, the
 * first lock's length, the longest a lock can grow to, and how long a quiet address is remembered.
 */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_BASE_SECONDS = 60;
export const LOCKOUT_MAX_SECONDS = 3600;
export const LOCKOUT_FORGET_SECONDS = 24 * 3600;
const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 15 * 60;

/** How long the lock lasts after the `failures`-th consecutive wrong password: 0 below the threshold, then 60 s, 120 s, 240 s ... up to an hour. */
export function lockSeconds(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** (failures - LOCKOUT_THRESHOLD), LOCKOUT_MAX_SECONDS);
}

/** Where a request with no usable address is counted. */
const UNKNOWN_IP = 'unknown';

/**
 * The local admin account for when Google sign-in is unavailable. It is always role `head`, has
 * an argon2id password hash, and exists only because an operator created it from the environment
 * (BREAK_GLASS_EMAIL/PASSWORD) or the CLI: there is no default password anywhere in the code.
 *
 * Sign-in is limited per IP address (10 attempts per 15 minutes) and the lockout is per
 * (account, IP): the 5th wrong password from an address locks that address out of that account for
 * a minute, and every further wrong one doubles the lock up to an hour. A lock never applies to
 * other addresses (an IPv6 address counts as its /64, T-125 C-7), so someone who knows the admin's email cannot lock the admin out by typing
 * wrong passwords from elsewhere (the old account-wide lock allowed exactly that). The price is
 * that a botnet gets 5 free guesses per address; against an argon2id hash of a 12+ character
 * password, behind the per-IP limit, that is accepted `[ASSUMED]`. A correct password during a
 * lock does not unlock it. Every attempt, wrong or right, is an audit row; a new lock is logged at
 * warn and has its own audit row. An operator can clear locks with the CLI (`--unlock`).
 */
@Injectable()
export class BreakGlassService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** See provisionBreakGlass. */
  provision(email: string, password: string, name?: string): Promise<ProvisionResult> {
    return provisionBreakGlass(this.database, this.passwords, email, password, name);
  }

  /**
   * Checks the credentials and returns the account, or throws 401 `invalid_credentials` (the same
   * body whether the account is missing, locked or the password is wrong) or 429.
   */
  async authenticate(email: string, password: string, ip: string | null): Promise<UserRow> {
    // An IPv6 client is counted as its /64 (T-125 C-7): a new address inside it is not a new guesser.
    const address = ipBucket(ip ?? UNKNOWN_IP);
    const limited = await this.limiter.hit('bg-ip', address, IP_LIMIT, IP_WINDOW_SECONDS);
    if (!limited.allowed) {
      AuditScope.set({ action: AUDIT_ACTIONS.breakGlassRateLimited, outcome: 'denied' });
      throw new RateLimitedError(limited.retryAfterSeconds);
    }

    const [user] = await this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const usable = user?.isBreakGlass === true && user.status === 'active' && user.passwordHash;
    if (!user || !usable) {
      await this.passwords.verifyAgainstDummy(password);
      AuditScope.set({
        action: AUDIT_ACTIONS.breakGlassFailed,
        outcome: 'failure',
        metadata: { reason: 'no_such_break_glass_account' },
      });
      throw invalidCredentials();
    }
    AuditScope.set({ targetType: 'user', targetId: user.id });

    const lockedUntil = await this.lockedUntil(user.id, address);
    if (lockedUntil !== null) {
      await this.passwords.verifyAgainstDummy(password);
      AuditScope.set({
        action: AUDIT_ACTIONS.breakGlassLocked,
        outcome: 'denied',
        metadata: { lockedUntil: lockedUntil.toISOString() },
      });
      throw invalidCredentials();
    }

    if (user.passwordHash && (await this.passwords.verify(user.passwordHash, password))) {
      await this.database.pool.query(
        'DELETE FROM break_glass_attempt WHERE user_id = $1 AND ip = $2',
        [user.id, address],
      );
      AuditScope.set({
        action: AUDIT_ACTIONS.breakGlassLogin,
        actor: { type: 'user', id: user.id },
      });
      return user;
    }

    const attempt = await this.recordFailure(user.id, address);
    AuditScope.set({
      action: AUDIT_ACTIONS.breakGlassFailed,
      outcome: 'failure',
      metadata: {
        reason: 'wrong_password',
        failedAttempts: attempt.failed,
        ...(attempt.lockedUntil === null ? {} : { lockedUntil: attempt.lockedUntil.toISOString() }),
      },
    });
    if (attempt.lockedUntil !== null) await this.announceLock(user.id, address, ip, attempt);
    throw invalidCredentials();
  }

  private async lockedUntil(userId: string, ip: string): Promise<Date | null> {
    const result = await this.database.pool.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM break_glass_attempt
       WHERE user_id = $1 AND ip = $2 AND locked_until > now()`,
      [userId, ip],
    );
    return result.rows[0]?.locked_until ?? null;
  }

  /**
   * Counts one wrong password from `ip` in a single statement, so parallel guesses cannot slip
   * under the threshold. A count that has been quiet for a day starts again at 1.
   */
  private async recordFailure(
    userId: string,
    ip: string,
  ): Promise<{ failed: number; lockedUntil: Date | null }> {
    const next = `(CASE WHEN a.last_failed_at < now() - make_interval(secs => $3)
                        THEN 1 ELSE a.failed_count + 1 END)`;
    const result = await this.database.pool.query<{
      failed_count: number;
      locked_until: Date | null;
    }>(
      `INSERT INTO break_glass_attempt AS a (user_id, ip, failed_count, last_failed_at)
       VALUES ($1, $2, 1, now())
       ON CONFLICT (user_id, ip) DO UPDATE SET
         failed_count = ${next},
         last_failed_at = now(),
         locked_until = CASE WHEN ${next} >= $4
           THEN now() + make_interval(secs => LEAST($5::float8 * power(2, ${next} - $4), $6::float8))
           ELSE NULL END
       RETURNING failed_count, locked_until`,
      [
        userId,
        ip,
        LOCKOUT_FORGET_SECONDS,
        LOCKOUT_THRESHOLD,
        LOCKOUT_BASE_SECONDS,
        LOCKOUT_MAX_SECONDS,
      ],
    );
    const row = result.rows[0];
    const lockedUntil = row?.locked_until ?? null;
    return {
      failed: row?.failed_count ?? 1,
      lockedUntil: lockedUntil !== null && lockedUntil.getTime() > Date.now() ? lockedUntil : null,
    };
  }

  /** A new lock is a security event: it has an audit row of its own and a warning in the log. */
  private async announceLock(
    userId: string,
    ip: string,
    rawIp: string | null,
    attempt: { failed: number; lockedUntil: Date | null },
  ): Promise<void> {
    const seconds = lockSeconds(attempt.failed);
    this.logger.warn(
      { userId, ip, failedAttempts: attempt.failed, lockedForSeconds: seconds },
      'break-glass sign-in locked for this client address after repeated wrong passwords',
    );
    try {
      await this.audit.record({
        actor: { type: 'system', id: 'break-glass-lockout' },
        action: AUDIT_ACTIONS.breakGlassLockout,
        outcome: 'denied',
        targetType: 'user',
        targetId: userId,
        ip: rawIp,
        metadata: {
          failedAttempts: attempt.failed,
          lockedForSeconds: seconds,
          lockedUntil: attempt.lockedUntil?.toISOString() ?? null,
        },
      });
    } catch (error) {
      // The failed attempt itself is audited by the interceptor; a missing extra row must not turn
      // a refusal into a 500 that tells the guesser something.
      this.logger.error({ err: error }, 'audit write failed for a break-glass lockout');
    }
  }
}

/**
 * Creates the break-glass account from BREAK_GLASS_EMAIL/PASSWORD when the api starts, and keeps
 * trying (every 30 s) if the database is not ready yet, because this account is needed most when
 * things are broken. With neither variable set it does nothing.
 */
@Injectable()
export class BreakGlassBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private settled: Promise<void> = Promise.resolve();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(BreakGlassService) private readonly breakGlass: BreakGlassService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.BREAK_GLASS_EMAIL || !this.config.BREAK_GLASS_PASSWORD) return;
    this.settled = this.attempt(this.config.BREAK_GLASS_EMAIL, this.config.BREAK_GLASS_PASSWORD);
  }

  /** Resolves once the first provisioning attempt has finished (success or scheduled retry). */
  whenSettled(): Promise<void> {
    return this.settled;
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private async attempt(email: string, password: string): Promise<void> {
    try {
      const result = await this.breakGlass.provision(email, password);
      if (result !== 'unchanged') {
        await this.audit.record({
          actor: { type: 'system', id: 'bootstrap' },
          action: AUDIT_ACTIONS.breakGlassProvisioned,
          targetType: 'user',
          metadata: { result, source: 'environment' },
        });
      }
      this.logger.info({ result }, 'break-glass account checked');
    } catch (error) {
      this.logger.error({ err: error }, 'break-glass provisioning failed; retrying in 30 s');
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.settled = this.attempt(email, password);
        }, 30_000);
        this.timer.unref();
      }
    }
  }
}
