import { createHash } from 'node:crypto';

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { EmailOutbox } from '../queue/queue.module.js';
import { UsersService, isUniqueViolation, type UserRow } from '../users/users.service.js';
import { RateLimiter } from './rate-limiter.js';
import { generateOpaqueToken, hashOpaqueToken } from './token.service.js';

/** DI token for the lookup that maps a new client's email to an organization (T-005). */
export const CLIENT_ORG_RESOLVER = Symbol('CLIENT_ORG_RESOLVER');

export interface ClientOrgResolver {
  /**
   * The organization a not-yet-known email belongs to (verified-domain allow-list, PRD section
   * 2.3), or null when none does. T-005 implements it over `organization.domains`. With the
   * default (always null) only clients that staff invited can sign in.
   */
  resolveOrgId(email: string): Promise<string | null>;
}

export const noClientOrgResolver: ClientOrgResolver = { resolveOrgId: () => Promise.resolve(null) };

const REQUEST_WINDOW_SECONDS = 15 * 60;
const MAX_REQUESTS_PER_EMAIL = 3;

/** A short, non-reversible tag of an address for the audit log (the address itself is PII). */
export function emailTag(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 16);
}

/**
 * Passwordless sign-in for client users.
 *
 *  - `request` always looks the same to the caller: it returns at once and the work (lookup,
 *    token, email job) happens afterwards, so neither the response body nor its timing says
 *    whether the address has an account.
 *  - The token is 256 random bits, stored only as a SHA-256 hash, valid MAGIC_LINK_TTL_SECONDS,
 *    and consumed by a single atomic UPDATE, so it works once even under a double click.
 *  - Asking again voids the earlier link. At most 3 mails per address per 15 minutes; beyond that
 *    the request is accepted and silently dropped.
 *  - The link carries the token in the URL fragment (never sent to a server, never in a log) and
 *    opens a page that POSTs it. A mail scanner that GETs the link therefore cannot burn it.
 */
@Injectable()
export class MagicLinkService implements OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(EmailOutbox) private readonly outbox: EmailOutbox,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
    @Inject(CLIENT_ORG_RESOLVER) private readonly orgs: ClientOrgResolver,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /** Starts the issue-and-send work and returns without waiting for it. */
  request(email: string, ip: string | null): void {
    AuditScope.set({ targetType: 'email', targetId: emailTag(email) });
    const work = this.issue(email, ip).catch((error: unknown) => {
      this.logger.error({ err: error }, 'magic link request failed');
    });
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /** Resolves when every request started so far has finished. Used by tests and on shutdown. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  private async issue(email: string, ip: string | null): Promise<void> {
    const perEmail = await this.limiter.hit(
      'magic-email',
      email,
      MAX_REQUESTS_PER_EMAIL,
      REQUEST_WINDOW_SECONDS,
    );
    if (!perEmail.allowed) {
      this.logger.warn({ emailTag: emailTag(email) }, 'magic link rate limited for this address');
      return;
    }

    let user = await this.users.findByEmail(email);
    if (!user) user = await this.provisionByDomain(email);
    if (user?.role !== 'client' || user.status !== 'active') return;

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.config.MAGIC_LINK_TTL_SECONDS * 1000);
    const hash = hashOpaqueToken(token);
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.magicLinkTokens)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(schema.magicLinkTokens.userId, user.id),
            isNull(schema.magicLinkTokens.consumedAt),
          ),
        );
      await tx
        .insert(schema.magicLinkTokens)
        .values({ userId: user.id, tokenHash: hash, expiresAt, requestedIp: ip });
    });

    const link = new URL('/login/magic', this.config.APP_URL);
    link.hash = `token=${token}`;
    await this.outbox.send(
      {
        kind: 'magic_link',
        to: user.email,
        link: link.toString(),
        expiresInMinutes: Math.ceil(this.config.MAGIC_LINK_TTL_SECONDS / 60),
      },
      `magic-link-${hash.slice(0, 32)}`,
    );
  }

  private async provisionByDomain(email: string): Promise<UserRow | undefined> {
    const orgId = await this.orgs.resolveOrgId(email);
    if (orgId === null) return undefined;
    try {
      const [row] = await this.database.db
        .insert(schema.users)
        .values({ email, name: email.split('@')[0] ?? email, role: 'client', orgId })
        .returning();
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) return this.users.findByEmail(email);
      throw error;
    }
  }

  /** Consumes a token. Returns the client it belongs to, or null if it is unknown, used, expired or the account is not usable. */
  async consume(token: string): Promise<UserRow | null> {
    const [consumed] = await this.database.db
      .update(schema.magicLinkTokens)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(schema.magicLinkTokens.tokenHash, hashOpaqueToken(token)),
          isNull(schema.magicLinkTokens.consumedAt),
          gt(schema.magicLinkTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: schema.magicLinkTokens.userId });
    if (!consumed) return null;
    const user = await this.users.findById(consumed.userId);
    return user?.role === 'client' && user.status === 'active' ? user : null;
  }
}
