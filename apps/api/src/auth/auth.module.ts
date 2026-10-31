import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { UsersController } from '../users/users.controller.js';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { BreakGlassBootstrap, BreakGlassService } from './break-glass.service.js';
import { GoogleOidcService, OIDC_OPTIONS, type OidcOptions } from './google-oidc.service.js';
import {
  CLIENT_ORG_RESOLVER,
  MagicLinkService,
  noClientOrgResolver,
} from './magic-link.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitFilter } from './rate-limit.filter.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/**
 * Authentication, sessions and users. Registers the global deny-by-default guard, so importing
 * this module is what makes every route in the app require a permission or `@Public()`.
 */
@Module({})
export class AuthModule {
  static forRoot(oidc: OidcOptions = {}): DynamicModule {
    return {
      module: AuthModule,
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
        // T-005 replaces this with a resolver over organization.domains (PRD section 2.3).
        { provide: CLIENT_ORG_RESOLVER, useValue: noClientOrgResolver },
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
      ],
    };
  }
}
