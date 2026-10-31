import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import {
  LOCKED_HEAD_PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSIONS,
  ROLES,
  isPermission,
  type Permission,
  type Role,
} from '@watchtower/shared';
import { eq } from 'drizzle-orm';

import { conflict } from '../auth/http-errors.js';
import { DATABASE } from '../database/database.module.js';

/** Role permissions are cached this long. A change made on another instance shows up within it. */
const CACHE_TTL_MS = 5000;

export interface RolePermissions {
  readonly role: Role;
  readonly permissions: Permission[];
}

/**
 * Which permissions each role has. The database is the source of truth (migration 0001 seeds the
 * defaults from PRD section 2.2), so a head can change a role through the API with no deploy.
 */
@Injectable()
export class RbacService {
  private cache: {
    readonly at: number;
    readonly roles: ReadonlyMap<Role, ReadonlySet<Permission>>;
  } | null = null;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  private async load(): Promise<ReadonlyMap<Role, ReadonlySet<Permission>>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.roles;
    const rows = await this.database.db.select().from(schema.rolePermissions);
    const roles = new Map<Role, Set<Permission>>(
      ROLES.map((role) => [role, new Set<Permission>()]),
    );
    for (const row of rows) {
      // Ignore strings the code does not know: a permission removed from the code stays inert.
      if (isPermission(row.permission)) roles.get(row.role as Role)?.add(row.permission);
    }
    this.cache = { at: now, roles };
    return roles;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Role permissions plus the per-user extras (service identities). Unknown strings are dropped. */
  async effectivePermissions(
    role: Role,
    extra: readonly string[],
  ): Promise<ReadonlySet<Permission>> {
    const fromRole = (await this.load()).get(role) ?? new Set<Permission>();
    const merged = new Set<Permission>(fromRole);
    for (const permission of extra) {
      if (isPermission(permission)) merged.add(permission);
    }
    return merged;
  }

  async listRoles(): Promise<RolePermissions[]> {
    this.invalidate();
    const roles = await this.load();
    return ROLES.map((role) => ({
      role,
      permissions: PERMISSION_KEYS.filter((key) => roles.get(role)?.has(key) === true),
    }));
  }

  catalog(): { key: Permission; description: string }[] {
    return PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key] }));
  }

  /** Replaces the permissions of a role. Returns the before and after sets for the audit log. */
  async setRolePermissions(
    role: Role,
    permissions: readonly Permission[],
  ): Promise<{ before: Permission[]; after: Permission[] }> {
    const wanted = new Set(permissions);
    if (role === 'head') {
      const missing = LOCKED_HEAD_PERMISSIONS.filter((permission) => !wanted.has(permission));
      if (missing.length > 0) {
        throw conflict(
          `The head role must keep ${missing.join(', ')}, or nobody could undo this change`,
        );
      }
    }
    const before = (await this.listRoles()).find((entry) => entry.role === role)?.permissions ?? [];
    await this.database.db.transaction(async (tx) => {
      await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.role, role));
      if (wanted.size > 0) {
        await tx
          .insert(schema.rolePermissions)
          .values([...wanted].map((permission) => ({ role, permission })));
      }
    });
    this.invalidate();
    return { before, after: PERMISSION_KEYS.filter((key) => wanted.has(key)) };
  }
}
