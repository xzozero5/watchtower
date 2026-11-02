import { Module } from '@nestjs/common';

import { APP_CONFIG, type ApiConfig } from '../config/config.js';
import { CredentialsModule } from '../credentials/credentials.module.js';
import { GmailOauthController } from './gmail-oauth.controller.js';
import { GMAIL_OAUTH_FETCH, GmailOauthService } from './gmail-oauth.service.js';
import { GmailSyncController } from './gmail-sync.controller.js';
import { GmailSyncService } from './gmail-sync.service.js';
import { GmailPushController } from './gmail-push.controller.js';
import { GMAIL_PUSH_VERIFIER, GmailPushService } from './gmail-push.service.js';
import { createGoogleKeySet, createOidcPushVerifier } from './push-verifier.js';

/**
 * Gmail Pub/Sub push receiver (T-102b) and the OAuth connection of the support mailbox (T-102e).
 * Every route needs `@RequirePermission` / `@RequireAnyPermission` or `@Public()`, and a public one
 * must also be listed in `./public-routes.ts`.
 *
 * The verifier is built only when both `GMAIL_PUSH_AUDIENCE` and `GMAIL_PUSH_SERVICE_ACCOUNT` are
 * set (live configuration). Without them it is `null` and the receiver answers 503: it never
 * accepts a notification it cannot authenticate. `createGoogleKeySet` (the only code that fetches
 * Google's keys) is therefore not reached in mock mode, nor in any test: tests replace this
 * provider with a verifier over a local key pair.
 *
 * The OAuth service reaches Google only when a head starts and finishes the flow
 * (`accounts.google.com` in the browser, `oauth2.googleapis.com` and `gmail.googleapis.com` from the
 * server). `GMAIL_OAUTH_FETCH` is null in production (the global `fetch`); tests replace it.
 */
@Module({
  imports: [CredentialsModule],
  controllers: [GmailPushController, GmailOauthController, GmailSyncController],
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
    { provide: GMAIL_OAUTH_FETCH, useValue: null },
    GmailPushService,
    GmailOauthService,
    GmailSyncService,
  ],
})
export class GmailModule {}
