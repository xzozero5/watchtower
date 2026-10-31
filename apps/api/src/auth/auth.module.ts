import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { OrgDomainResolver } from '../orgs/org-domain-resolver.js';
import { OrgsModule } from '../orgs/orgs.module.js';
import { UsersController } from '../users/users.controller.js';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { BreakGlassBootstrap, BreakGlassService } from './break-glass.service.js';
import { GoogleOidcService, OIDC_OPTIONS, type OidcOptions } from './google-oidc.service.js';
import { CLIENT_ORG_RESOLVER, MagicLinkService } from './magic-link.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitFilter } from './rate-limit.filter.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * Authentication, sessions and users. Registers the global deny-by-default guard, so importing
 * this module is what makes every route in the app require a permission or `@Public()`.
 *
 * Global, so that other transports that authenticate on their own (the WebSocket handshake in
 * RealtimeGateway) can use TokenService, SessionService and AuthService.
 */
@Module({})
export class AuthModule {
  static forRoot(oidc: OidcOptions = {}): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      imports: [OrgsModule],
      controllers: [AuthController, UsersController],
      providers: [
        TokenService,
        SessionService,
        PasswordService,
        RateLimiter,
        GoogleOidcService,
        MagicLinkService,
        BreakGlassService,
        BreakGlassBootstrap,
        AuthService,
        UsersService,
        { provide: OIDC_OPTIONS, useValue: oidc },
        // Which organization a not-yet-known client address joins: its domain in organization.domains.
        { provide: CLIENT_ORG_RESOLVER, useExisting: OrgDomainResolver },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: RateLimitFilter },
      ],
      exports: [
        TokenService,
        SessionService,
        UsersService,
        AuthService,
        BreakGlassService,
        PasswordService,
        RateLimiter,
        CLIENT_ORG_RESOLVER,
      ],
    };
  }
}
