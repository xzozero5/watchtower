import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { and, eq, notInArray } from 'drizzle-orm';

import { DATABASE } from '../database/database.module.js';
import { ORG_NAME_LIMIT } from '../masking/org-names.js';

const CACHE_MS = 60_000;

export interface StaffPeople {
  readonly names: readonly string[];
  /** False when there are more people than the redactor can take: the list was cut short. */
  readonly complete: boolean;
}

/**
 * The names of the people who work in this instance (everyone who signs in but a customer), for the
 * redactor's dictionary (N4). A person's name in a ticket subject, a handoff title or what someone
 * typed is replaced before a model sees it, the same as a customer's. A new colleague is known within
 * a minute. If there are more people than the redactor can take, `complete` is false and the callers
 * send nothing to a model (fail closed, like the list of an organization). The redactor has no name
 * recognition of its own, so a name nobody listed still goes through `[UNVERIFIED 70%]`.
 */
@Injectable()
export class StaffNames {
  private cache: { readonly at: number; readonly people: StaffPeople } | null = null;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(): Promise<StaffPeople> {
    if (this.cache !== null && Date.now() - this.cache.at < CACHE_MS) return this.cache.people;
    const rows = await this.database.db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(
        and(eq(schema.users.status, 'active'), notInArray(schema.users.role, ['client', 'system'])),
      )
      .limit(ORG_NAME_LIMIT + 1);
    const people: StaffPeople = {
      names: rows.slice(0, ORG_NAME_LIMIT).map((row) => row.name),
      complete: rows.length <= ORG_NAME_LIMIT,
    };
    this.cache = { at: Date.now(), people };
    return people;
  }
}
