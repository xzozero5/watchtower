import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import type { CreateUser, Role, UpdateUser, User, UserStatus } from '@watchtower/shared';
import { asc, eq, sql } from 'drizzle-orm';

import { AuditScope } from '../audit/audit-scope.js';
import { conflict, forbidden, notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { SessionService } from '../auth/session.service.js';
import { DATABASE } from '../database/database.module.js';

export type UserRow = typeof schema.users.$inferSelect;

/** Postgres unique_violation, which drizzle reports on `cause` for query errors. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (candidate: unknown): unknown =>
    typeof candidate === 'object' && candidate !== null && 'code' in candidate
      ? candidate.code
      : undefined;
  return (
    code(error) === '23505' ||
    (typeof error === 'object' &&
      error !== null &&
      'cause' in error &&
      code(error.cause) === '23505')
  );
}

/** What an audit entry records about a user: never the password hash or other credentials. */
export function userSnapshot(row: UserRow): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    orgId: row.orgId,
    isBreakGlass: row.isBreakGlass,
  };
}

export function toApiUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    status: row.status as UserStatus,
    orgId: row.orgId,
    isBreakGlass: row.isBreakGlass,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return row;
  }

  async list(): Promise<UserRow[]> {
    return this.database.db.select().from(schema.users).orderBy(asc(schema.users.email));
  }

  /** Staff accounts need `user.manage`; client accounts need only `client.invite` (lead and head). */
  async create(input: CreateUser, actor: Principal): Promise<UserRow> {
    const permission = input.role === 'client' ? 'client.invite' : 'user.manage';
    if (!actor.permissions.has(permission)) {
      throw forbidden(`Creating a ${input.role} requires ${permission}`);
    }
    try {
      const [row] = await this.database.db
        .insert(schema.users)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          orgId: input.orgId ?? null,
        })
        .returning();
      if (!row) throw new Error('user insert returned no row');
      AuditScope.set({ targetType: 'user', targetId: row.id, after: userSnapshot(row) });
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('An account with this email already exists');
      throw error;
    }
  }

  async update(id: string, patch: UpdateUser, actor: Principal): Promise<UserRow> {
    const before = await this.findById(id);
    if (!before) throw notFound('No such user');
    AuditScope.set({ targetType: 'user', targetId: id, before: userSnapshot(before) });
    if (before.isBreakGlass) {
      throw conflict('The break-glass account can only be managed with the CLI');
    }
    if (before.role === 'client' && patch.role !== undefined) {
      throw conflict('A client cannot become staff; invite a new account instead');
    }
    if (id === actor.userId && (patch.role !== undefined || patch.status !== undefined)) {
      throw conflict('You cannot change your own role or status');
    }

    const [row] = await this.database.db
      .update(schema.users)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.role === undefined ? {} : { role: patch.role }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        updatedAt: sql`now()`,
      })
      .where(eq(schema.users.id, id))
      .returning();
    if (!row) throw notFound('No such user');
    if (patch.status === 'disabled') {
      const revoked = await this.sessions.revokeAllForUser(id, 'user_disabled');
      AuditScope.set({ metadata: { revokedSessions: revoked } });
    }
    AuditScope.set({ after: userSnapshot(row) });
    return row;
  }
}
