import {
  BadRequestException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  WORKSPACE_ROLES,
  type AuthMethod,
  type DevLoginRequest,
  type Role,
  type SessionInfo,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';
import type { Request } from 'express';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { LOGGER, type AppLogger } from '../logging/logger.js';
import { RbacService } from '../rbac/rbac.service.js';
import { UsersService, isUniqueViolation, type UserRow } from '../users/users.service.js';
import type { GoogleIdentity } from './google-oidc.service.js';
import { forbidden, notFound } from './http-errors.js';
import { orgScopeFor, type Principal } from './principal.js';
import { clipUserAgent, type IssuedSession, type RequestMeta } from './session.service.js';

/** Why a Google sign-in was refused. Becomes `?error=` on the redirect to the login page. */
export type GoogleLoginFailure =
  | 'email_not_verified'
  | 'domain_not_allowed'
  | 'staff_not_provisioned'
  | 'account_disabled'
  | 'account_mismatch';

/** Which staff rule let a Google sign-in through; recorded in the login audit entry. */
export type GoogleLoginRule = 'domain' | 'allowlist';

export class GoogleLoginRejected extends Error {
  constructor(readonly failure: GoogleLoginFailure) {
    super(failure);
    this.name = 'GoogleLoginRejected';
  }
}

/** Who signs in with the company account: staff and developers (T-137). */
const STAFF: readonly Role[] = WORKSPACE_ROLES;

export function requestMeta(request: Request): RequestMeta {
  return { ip: request.ip ?? null, userAgent: clipUserAgent(request.header('user-agent')) };
}

/** Decisions about who may sign in, and the shape of what a sign-in returns. */
@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(RbacService) private readonly rbac: RbacService,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.devLoginEnabled) {
      this.logger.warn(
        'dev login is ON (DEV_LOGIN_ENABLED=true, no Google credentials): POST /v1/auth/dev-login signs anyone in as any role, for accounts it created. Local development only.',
      );
    }
  }

  /**
   * Applies the staff rules to a verified Google identity: the email is verified, the `hd` claim
   * and the address are both on the allowed Workspace domain (or the address is on the allow-list), and the account was provisioned by
   * a head (no self-registration).
   */
  async resolveGoogleUser(
    identity: GoogleIdentity,
  ): Promise<{ readonly user: UserRow; readonly via: GoogleLoginRule }> {
    const domain = this.config.staffDomain;
    if (!identity.emailVerified) throw new GoogleLoginRejected('email_not_verified');
    // Two ways in, either is enough: the Workspace domain (hd claim and address), or an exact
    // address on GOOGLE_ALLOWED_EMAILS (trial instances only; the list is empty in production).
    // The address is already trimmed and lower-cased; the list entries are too. No wildcards.
    let via: GoogleLoginRule;
    if (identity.hostedDomain === domain && identity.email.endsWith(`@${domain}`)) {
      via = 'domain';
    } else if (this.config.GOOGLE_ALLOWED_EMAILS.includes(identity.email)) {
      via = 'allowlist';
    } else {
      throw new GoogleLoginRejected('domain_not_allowed');
    }

    const user = await this.users.findByEmail(identity.email);
    if (!user || !STAFF.includes(user.role as Role) || user.isBreakGlass) {
      throw new GoogleLoginRejected('staff_not_provisioned');
    }
    if (user.status !== 'active') throw new GoogleLoginRejected('account_disabled');
    if (user.googleSub === null) {
      try {
        await this.database.db
          .update(schema.users)
          .set({ googleSub: identity.sub, updatedAt: sql`now()` })
          .where(eq(schema.users.id, user.id));
      } catch (error) {
        // The same Google account is already linked to another user.
        if (isUniqueViolation(error)) throw new GoogleLoginRejected('account_mismatch');
        throw error;
      }
    } else if (user.googleSub !== identity.sub) {
      // The mailbox now belongs to a different Google account than the one first linked.
      throw new GoogleLoginRejected('account_mismatch');
    }
    return { user, via };
  }

  /**
   * Mock-mode sign-in for local development: no password, no network. Exists only when
   * DEV_LOGIN_ENABLED=true, Google is in mock mode and NODE_ENV is not production (all checked at
   * boot); otherwise 404 as if the route did not exist.
   *
   * It signs in only to accounts it created itself (`dev_created`). An account made any other way
   * (invited by a head, provisioned by domain, seeded, a break-glass admin, a real person who
   * happens to share the address) is refused, so turning this on by mistake on a database with
   * real accounts still cannot sign anyone in as them.
   */
  async devLogin(input: DevLoginRequest): Promise<UserRow> {
    if (!this.config.devLoginEnabled) throw notFound();

    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      if (!existing.devCreated || existing.status !== 'active' || existing.isBreakGlass) {
        throw forbidden();
      }
      if (existing.role === 'system') throw forbidden();
      return existing;
    }
    if (input.role === 'client') {
      if (!input.orgId) throw new BadRequestException('orgId is required to create a client');
    } else if (!input.email.endsWith(`@${this.config.staffDomain}`)) {
      throw forbidden(`Staff dev accounts need an email at ${this.config.staffDomain}`);
    }
    try {
      const [row] = await this.database.db
        .insert(schema.users)
        .values({
          email: input.email,
          name: input.name ?? input.email.split('@')[0] ?? input.email,
          role: input.role,
          orgId: input.role === 'client' ? (input.orgId ?? null) : null,
          devCreated: true,
        })
        .returning();
      if (!row) throw new Error('user insert returned no row');
      return row;
    } catch (error) {
      // Two first-time requests for the same address: the loser signs in only if the winner was dev login.
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.users.findByEmail(input.email);
      if (!winner?.devCreated || winner.status !== 'active') throw forbidden();
      return winner;
    }
  }

  async principalFor(
    user: UserRow,
    session: { readonly id: string; readonly authMethod: string },
    accessExpiresAt: Date,
  ): Promise<Principal> {
    const role = user.role as Role;
    return {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      name: user.name,
      role,
      orgId: user.orgId,
      authMethod: session.authMethod as AuthMethod,
      accessExpiresAt,
      permissions: await this.rbac.effectivePermissions(role, user.permissions),
      orgScope: orgScopeFor(role, user.orgId),
    };
  }

  async sessionInfo(
    user: UserRow,
    issued: Pick<IssuedSession, 'sessionId' | 'csrfToken' | 'accessExpiresAt'>,
    method: AuthMethod,
  ): Promise<SessionInfo> {
    const permissions = await this.rbac.effectivePermissions(user.role as Role, user.permissions);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as Role,
        orgId: user.orgId,
      },
      permissions: [...permissions].toSorted(),
      sessionId: issued.sessionId,
      authMethod: method,
      csrfToken: issued.csrfToken,
      accessExpiresAt: issued.accessExpiresAt.toISOString(),
    };
  }
}
