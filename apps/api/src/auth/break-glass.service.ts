import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { AUDIT_ACTIONS } from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import type { UserRow } from '../users/users.service.js';
import { provisionBreakGlass, type ProvisionResult } from './break-glass-provision.js';
import { invalidCredentials, RateLimitedError } from './http-errors.js';
import { PasswordService } from './password.service.js';
import { RateLimiter } from './rate-limiter.js';

/** Failed passwords before the account locks, and how long the lock lasts. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_SECONDS = 15 * 60;
const IP_LIMIT = 10;
const IP_WINDOW_SECONDS = 15 * 60;

/**
 * The local admin account for when Google sign-in is unavailable. It is always role `head`, has
 * an argon2id password hash, and exists only because an operator created it from the environment
 * (BREAK_GLASS_EMAIL/PASSWORD) or the CLI: there is no default password anywhere in the code.
 *
 * Sign-in is limited per IP address (10 attempts per 15 minutes) and per account (5 wrong
 * passwords lock it for 15 minutes; a correct password during the lock does not unlock it).
 * Every attempt, wrong or right, is an audit row.
 */
@Injectable()
export class BreakGlassService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
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
    const limited = await this.limiter.hit('bg-ip', ip ?? 'unknown', IP_LIMIT, IP_WINDOW_SECONDS);
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

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.passwords.verifyAgainstDummy(password);
      AuditScope.set({
        action: AUDIT_ACTIONS.breakGlassLocked,
        outcome: 'denied',
        metadata: { lockedUntil: user.lockedUntil.toISOString() },
      });
      throw invalidCredentials();
    }

    if (user.passwordHash && (await this.passwords.verify(user.passwordHash, password))) {
      await this.database.db
        .update(schema.users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, user.id));
      AuditScope.set({
        action: AUDIT_ACTIONS.breakGlassLogin,
        actor: { type: 'user', id: user.id },
      });
      return user;
    }

    // Count atomically so parallel guesses cannot slip under the threshold.
    const [updated] = await this.database.db
      .update(schema.users)
      .set({
        failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
        lockedUntil: sql`CASE WHEN ${schema.users.failedLoginCount} + 1 >= ${LOCKOUT_THRESHOLD}
          THEN now() + make_interval(secs => ${LOCKOUT_SECONDS}) ELSE ${schema.users.lockedUntil} END`,
      })
      .where(eq(schema.users.id, user.id))
      .returning({ failed: schema.users.failedLoginCount, lockedUntil: schema.users.lockedUntil });
    AuditScope.set({
      action: AUDIT_ACTIONS.breakGlassFailed,
      outcome: 'failure',
      metadata: {
        reason: 'wrong_password',
        failedAttempts: updated?.failed,
        ...(updated?.lockedUntil && updated.lockedUntil.getTime() > Date.now()
          ? { lockedUntil: updated.lockedUntil.toISOString() }
          : {}),
      },
    });
    throw invalidCredentials();
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
