import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { SeedTicketFilter } from '@watchtower/domain';

import { DATABASE } from '../database/database.module.js';

/**
 * The one place that decides whether a report leaves out the tickets of a seed batch (migration 0096). The
 * logic is `SeedTicketFilter` in the domain, shared with the worker; this class only lets Nest inject it.
 */
@Injectable()
export class SeedFilter extends SeedTicketFilter {
  constructor(@Inject(DATABASE) database: Database) {
    super(database);
  }
}
