import { schema, type Database } from '@watchtower/db';
import { MIN_BREAK_GLASS_PASSWORD_LENGTH } from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import type { PasswordService } from './password.service.js';

export type ProvisionResult = 'created' | 'updated' | 'unchanged';

export const DEFAULT_BREAK_GLASS_NAME = 'Break-glass admin';

/**
 * Creates the break-glass admin (role head, argon2id hash), or resets its password when it differs
 * from `password`. Idempotent. Shared by the api's boot-time provisioning (BREAK_GLASS_* env) and
 * the CLI (`pnpm --filter @watchtower/api break-glass`), neither of which has a default password.
 */
export async function provisionBreakGlass(
  database: Database,
  passwords: PasswordService,
  email: string,
  password: string,
  name: string = DEFAULT_BREAK_GLASS_NAME,
): Promise<ProvisionResult> {
  if (password.length < MIN_BREAK_GLASS_PASSWORD_LENGTH) {
    throw new Error(
      `break-glass password must be at least ${String(MIN_BREAK_GLASS_PASSWORD_LENGTH)} characters`,
    );
  }
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized))
    throw new Error('break-glass email is not an email address');

  const [existing] = await database.db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalized))
    .limit(1);

  if (!existing) {
    await database.db.insert(schema.users).values({
      email: normalized,
      name,
      role: 'head',
      isBreakGlass: true,
      passwordHash: await passwords.hash(password),
    });
    return 'created';
  }
  if (!existing.isBreakGlass) {
    throw new Error('that email already belongs to a normal account; use a different address');
  }
  if (existing.passwordHash && (await passwords.verify(existing.passwordHash, password))) {
    return 'unchanged';
  }
  await database.db
    .update(schema.users)
    .set({ passwordHash: await passwords.hash(password), status: 'active', updatedAt: sql`now()` })
    .where(eq(schema.users.id, existing.id));
  return 'updated';
}
