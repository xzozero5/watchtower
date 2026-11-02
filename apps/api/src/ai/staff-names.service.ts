import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { and, eq, notInArray } from 'drizzle-orm';

import { DATABASE } from '../database/database.module.js';

const MAX_NAMES = 300;
const CACHE_MS = 60_000;

/**
 * The names of the people who work in this instance (everyone who signs in but a customer), for the
 * redactor's dictionary (N4). A person's name in a ticket subject, a handoff title or what someone
 * typed is replaced before a model sees it, the same as a customer's. A new colleague is known within
 * a minute. The redactor has no name recognition of its own, so a name nobody listed still goes through
 * `[UNVERIFIED 70%]`.
 */
@Injectable()
export class StaffNames {
  private cache: { readonly at: number; readonly names: readonly string[] } | null = null;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(): Promise<readonly string[]> {
    if (this.cache !== null && Date.now() - this.cache.at < CACHE_MS) return this.cache.names;
    const rows = await this.database.db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(
        and(eq(schema.users.status, 'active'), notInArray(schema.users.role, ['client', 'system'])),
      )
      .limit(MAX_NAMES);
    const names = rows.map((row) => row.name);
    this.cache = { at: Date.now(), names };
    return names;
  }
}
