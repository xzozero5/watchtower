import { Module } from '@nestjs/common';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { LineIdentityController } from './line-identity.controller.js';
import { LineIdentityService } from './line-identity.service.js';
import { LINE_LOGIN_PROVIDER, lineLoginProviderFor } from './line-login.js';
import { LineQuotaController } from './line-quota.controller.js';
import { LineWebhookController } from './line-webhook.controller.js';
import { LineWebhookService } from './line-webhook.service.js';

/**
 * LINE Official Account (T-103): the webhook receiver (b), the quota read model (c) and the
 * identity link, by staff code or LINE Login (d). Sending and downloading media are the worker's.
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts`.
 *
 * Credentials are read through the credential store (`CREDENTIAL_STORE`, ADR-012), never from
 * `process.env`.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [LineWebhookController, LineIdentityController, LineQuotaController],
  providers: [
    LineWebhookService,
    LineIdentityService,
    {
      provide: LINE_LOGIN_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) => lineLoginProviderFor(config),
    },
  ],
})
export class LineModule {}
