import { Module } from '@nestjs/common';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { createGoogleKeySet, createOidcPushVerifier } from '../gmail/push-verifier.js';
import { AlertsIngestController } from './alerts-ingest.controller.js';
import { ALERT_PUSH_VERIFIER, AlertIngestService } from './alerts-ingest.service.js';
import { AlertsReader } from './alerts-reader.service.js';
import { AlertsController } from './alerts.controller.js';
import { EscalationPoliciesController, ServicesController } from './catalog.controller.js';
import { AlertsCatalog } from './catalog.service.js';

/**
 * Alerts, the service catalog and escalation policies (T-201, ADR-015). Every route needs
 * `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one must also be listed
 * in `./public-routes.ts`.
 *
 * The Pub/Sub verifier is built only when both `ALERT_PUSH_AUDIENCE` and `ALERT_PUSH_SERVICE_ACCOUNT`
 * are set (live configuration); without them it is `null` and the GCP route answers 503, never
 * accepting a notification it cannot authenticate. `createGoogleKeySet` (the only code that fetches
 * Google's keys) is therefore not reached in mock mode, nor in any test: tests replace this provider
 * with a verifier over a local key set.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [
    AlertsIngestController,
    AlertsController,
    ServicesController,
    EscalationPoliciesController,
  ],
  providers: [
    {
      provide: ALERT_PUSH_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.ALERT_PUSH_AUDIENCE !== undefined && config.ALERT_PUSH_SERVICE_ACCOUNT !== undefined
          ? createOidcPushVerifier({
              audience: config.ALERT_PUSH_AUDIENCE,
              serviceAccountEmail: config.ALERT_PUSH_SERVICE_ACCOUNT,
              keys: createGoogleKeySet(),
            })
          : null,
    },
    AlertIngestService,
    AlertsReader,
    AlertsCatalog,
  ],
})
export class AlertsModule {}
