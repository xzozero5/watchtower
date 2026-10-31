import { Global, Module } from '@nestjs/common';
import { createDomain, type Domain } from '@watchtower/domain';
import { KEY_LABELS, deriveSubkey } from '@watchtower/shared/secret-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';

/** DI token of the shared write logic (`packages/domain`, ADR-009). Inject with `@Inject(DOMAIN)`. */
export const DOMAIN = Symbol('DOMAIN');
export type { Domain };

/**
 * Builds the domain once from the validated api config. The worker builds its own from the worker
 * config; `TICKET_KEY_PREFIX` and `APP_ENCRYPTION_KEY` must be the same in both.
 *
 * No policy gate is given yet (T-112 implements it), so the domain refuses every customer-bound AI
 * action: fail closed (N3).
 */
@Global()
@Module({
  providers: [
    {
      provide: DOMAIN,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): Domain =>
        createDomain({
          ticketKeyPrefix: config.TICKET_KEY_PREFIX,
          sealKey: deriveSubkey(config.APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret),
        }),
    },
  ],
  exports: [DOMAIN],
})
export class DomainModule {}
