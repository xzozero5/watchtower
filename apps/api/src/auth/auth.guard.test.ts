import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service.js';
import type { AppLogger } from '../logging/logger.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthService } from './auth.service.js';
import { PUBLIC_KEY } from './decorators.js';
import type { SessionService } from './session.service.js';
import type { TokenService } from './token.service.js';

function guardFor(isPublic: boolean) {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === PUBLIC_KEY && isPublic ? true : undefined)),
  } as unknown as Reflector;
  return new AuthGuard(
    reflector,
    {} as TokenService,
    {} as SessionService,
    {} as AuthService,
    {} as AuditService,
    { error: vi.fn() } as unknown as AppLogger,
    { cookieSecure: false },
  );
}

const contextOfType = (type: string) =>
  ({
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => Object,
  }) as unknown as ExecutionContext;

describe('AuthGuard on transports other than HTTP', () => {
  it.each(['ws', 'rpc'])('refuses a %s handler that is not marked @Public()', async (type) => {
    await expect(guardFor(false).canActivate(contextOfType(type))).resolves.toBe(false);
  });

  it('lets a gateway through only when it opts out with @Public() (and authenticates itself)', async () => {
    await expect(guardFor(true).canActivate(contextOfType('ws'))).resolves.toBe(true);
  });
});
