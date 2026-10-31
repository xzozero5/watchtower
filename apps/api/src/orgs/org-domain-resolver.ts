import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@watchtower/db';
import { emailDomain, isFreeMailDomain } from '@watchtower/shared';
import { and, arrayContains, eq } from 'drizzle-orm';

import type { ClientOrgResolver } from '../auth/magic-link.service.js';
import { DATABASE } from '../database/database.module.js';

/**
 * `CLIENT_ORG_RESOLVER` (PRD section 2.3): an address whose domain an organization has claimed in
 * `organization.domains` may sign in as a client of that organization. Possession of the mailbox is
 * proved by the magic link itself; this only decides which organization the new account joins.
 *
 * Safe by construction:
 *  - the domain must match exactly (no subdomains, no suffixes);
 *  - an inactive organization takes nobody new;
 *  - a public mailbox provider never resolves, even if one slipped into the table by hand
 *    (the API refuses to store one, this is the second lock);
 *  - a domain belongs to at most one organization (database trigger), so the answer is unambiguous.
 */
@Injectable()
export class OrgDomainResolver implements ClientOrgResolver {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async resolveOrgId(email: string): Promise<string | null> {
    const domain = emailDomain(email);
    if (domain === null || isFreeMailDomain(domain)) return null;
    const [row] = await this.database.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(
        and(
          arrayContains(schema.organization.domains, [domain]),
          eq(schema.organization.status, 'active'),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
}
