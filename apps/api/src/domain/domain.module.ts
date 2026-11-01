import { Global, Module } from '@nestjs/common';
import type { Database } from '@watchtower/db';
import { createDomain, createPolicyGate, type Domain } from '@watchtower/domain';
import { CSAT_LANDING_PATH } from '@watchtower/shared';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';

/** DI token of the shared write logic (`packages/domain`, ADR-009). Inject with `@Inject(DOMAIN)`. */
export const DOMAIN = Symbol('DOMAIN');
export type { Domain };

/**
 * Builds the domain once from the validated api config. The worker builds its own from the worker
 * config; `TICKET_KEY_PREFIX` and `APP_ENCRYPTION_KEY` must be the same in both.
 *
 * The policy gate is the real one (T-112a, ADR-011): it reads the stage of the intent and the two
 * global switches from the database on every call, so a flipped switch applies to the next action.
 * The worker builds the same gate with `createPolicyGate` from its own database handle. Without a
 * gate the domain would refuse every customer-bound AI action (fail closed, N3).
 */
@Global()
@Module({
  providers: [
    {
      provide: DOMAIN,
      inject: [APP_CONFIG, DATABASE],
      useFactory: (config: ApiConfig, database: Database): Domain =>
        createDomain({
          ticketKeyPrefix: config.TICKET_KEY_PREFIX,
          sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
          portalUrl: new URL('/portal', config.APP_URL).toString(),
          csat: {
            signingKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.csatLink),
            landingUrl: new URL(CSAT_LANDING_PATH, config.APP_URL).toString(),
          },
          policyGate: createPolicyGate({ db: database.db }),
        }),
    },
  ],
  exports: [DOMAIN],
})
export class DomainModule {}
