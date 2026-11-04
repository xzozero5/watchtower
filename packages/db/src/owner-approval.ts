import { AUDIT_ACTIONS } from '@watchtower/shared';
import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/** The permission only the schema owner can hand to a person (migration 0096, ADR-025). */
export const OWNER_APPROVAL_PERMISSION = 'ai.autonomy.owner_approve';

export type OwnerApprovalChange = 'granted' | 'revoked' | 'unchanged';

/**
 * Puts `ai.autonomy.owner_approve` into (or takes it out of) `users.permissions` of one active person.
 * Run it with the schema owner's connection: a trigger refuses anyone else (`users_guard_owner_approval`).
 * Writes an audit row (no secret, no email: the user id). Returns what happened; `null` when no active
 * user has that address.
 */
export async function setOwnerApproval(
  database: Database,
  email: string,
  grant: boolean,
): Promise<{ readonly userId: string; readonly change: OwnerApprovalChange } | null> {
  return database.db.transaction(async (tx) => {
    const found = await tx.execute<{ id: string; has: boolean }>(
      sql`SELECT id, ${OWNER_APPROVAL_PERMISSION} = ANY (permissions) AS has
            FROM users WHERE email = ${email.trim().toLowerCase()} AND status = 'active' FOR UPDATE`,
    );
    const user = found.rows[0];
    if (user === undefined) return null;
    if (user.has === grant) return { userId: user.id, change: 'unchanged' as const };
    await tx.execute(
      grant
        ? sql`UPDATE users SET permissions = array_append(permissions, ${OWNER_APPROVAL_PERMISSION}), updated_at = now() WHERE id = ${user.id}::uuid`
        : sql`UPDATE users SET permissions = array_remove(permissions, ${OWNER_APPROVAL_PERMISSION}), updated_at = now() WHERE id = ${user.id}::uuid`,
    );
    await tx.execute(
      sql`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, outcome, metadata)
          VALUES ('system', 'cli', ${AUDIT_ACTIONS.autonomyOwnerApprovalSet}, 'user', ${user.id}, 'success',
                  ${JSON.stringify({ permission: OWNER_APPROVAL_PERMISSION, granted: grant })}::jsonb)`,
    );
    return { userId: user.id, change: grant ? ('granted' as const) : ('revoked' as const) };
  });
}
