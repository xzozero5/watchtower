import { Module } from '@nestjs/common';
import { createCredentialStore, type Database } from '@watchtower/db';
import { pickCredentialEnv } from '@watchtower/shared';
import { localKmsFromConfig } from '@watchtower/shared/credential-box';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { DATABASE } from '../database/database.module.js';
import { ConnectionTesterRegistry } from './connection-tester.js';
import { CredentialsController } from './credentials.controller.js';
import { CREDENTIAL_STORE, CredentialsService } from './credentials.service.js';

/**
 * Integration credential store, head only (T-116a, ADR-004, ADR-012): `/v1/admin/integrations`.
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts` (none here).
 *
 * Adapters read values through `CREDENTIAL_STORE` (`store.resolve(integration)`), never from
 * `process.env`, and register their "test connection" with `ConnectionTesterRegistry`.
 */
@Module({
  controllers: [CredentialsController],
  providers: [
    {
      provide: CREDENTIAL_STORE,
      inject: [DATABASE, APP_CONFIG],
      useFactory: (database: Database, config: ApiConfig) =>
        createCredentialStore({
          database,
          kms: localKmsFromConfig(config),
          env: pickCredentialEnv(config),
        }),
    },
    ConnectionTesterRegistry,
    CredentialsService,
  ],
  exports: [CREDENTIAL_STORE, ConnectionTesterRegistry, CredentialsService],
})
export class CredentialsModule {}
