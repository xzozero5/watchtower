import { Module } from '@nestjs/common';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { GmailPushController } from './gmail-push.controller.js';
import { GMAIL_PUSH_VERIFIER, GmailPushService } from './gmail-push.service.js';
import { createGoogleKeySet, createOidcPushVerifier } from './push-verifier.js';

/**
 * Gmail Pub/Sub push receiver (T-102b). Account settings (T-102e) come later. Every route needs
 * `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one must also be
 * listed in `./public-routes.ts`.
 *
 * The verifier is built only when both `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT` are
 * set (live configuration). Without them it is `null` and the receiver answers 503: it never
 * accepts a notification it cannot authenticate. `createGoogleKeySet` (the only code that fetches
 * Google's keys) is therefore not reached in mock mode, nor in any test: tests replace this
 * provider with a verifier over a local key pair.
 */
@Module({
  controllers: [GmailPushController],
  providers: [
    {
      provide: GMAIL_PUSH_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.GMAIL_PUSH_AUDIENCE !== undefined && config.GMAIL_PUSH_SERVICE_ACCOUNT !== undefined
          ? createOidcPushVerifier({
              audience: config.GMAIL_PUSH_AUDIENCE,
              serviceAccountEmail: config.GMAIL_PUSH_SERVICE_ACCOUNT,
              keys: createGoogleKeySet(),
            })
          : null,
    },
    GmailPushService,
  ],
})
export class GmailModule {}
