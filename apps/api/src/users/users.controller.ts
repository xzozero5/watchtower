import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  createUserSchema,
  forceLogoutResultSchema,
  updateUserSchema,
  userIdParamSchema,
  userListSchema,
  userSchema,
  type CreateUser,
  type UpdateUser,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
} from '../auth/decorators.js';
import { notFound } from '../auth/http-errors.js';
import type { Principal } from '../auth/principal.js';
import { SessionService } from '../auth/session.service.js';
import { parseResponse } from '../common/zod-openapi.js';
import { toApiUser, UsersService } from './users.service.js';

@ApiTags('users')
@Controller('v1/users')
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get()
  @RequirePermission('user.read')
  @AuditPiiRead('user')
  @ApiOperation({ summary: 'List users (lead and head)' })
  @ApiOkResponse({ standardSchema: userListSchema })
  async list() {
    return parseResponse(userListSchema, { users: (await this.users.list()).map(toApiUser) });
  }

  @Post()
  // Which of the two applies depends on the role in the body; UsersService checks it.
  @RequireAnyPermission('user.manage', 'client.invite')
  @Audited({ action: AUDIT_ACTIONS.userCreate, targetType: 'user' })
  @ApiOperation({
    summary: 'Create a staff account (user.manage) or invite a client (client.invite)',
    description:
      'A client belongs to exactly one organization (`orgId`). Staff sign in with Google; a client ' +
      'signs in with a magic link sent to this address.',
  })
  @ApiCreatedResponse({ standardSchema: userSchema })
  @ApiConflictResponse({ description: 'The email already has an account' })
  async create(
    @Body({ schema: createUserSchema }) body: CreateUser,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(userSchema, toApiUser(await this.users.create(body, principal)));
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  @Audited({ action: AUDIT_ACTIONS.userUpdate, targetType: 'user' })
  @ApiOperation({
    summary: 'Change a user name, staff role or status',
    description:
      'Disabling an account ends all its sessions at once. You cannot change your own role or ' +
      'status, and the break-glass account is not editable here.',
  })
  @ApiOkResponse({ standardSchema: userSchema })
  @ApiNotFoundResponse({ description: 'No such user' })
  @ApiConflictResponse({ description: 'Not allowed on this account' })
  async update(
    @Param({ schema: userIdParamSchema }) params: z.infer<typeof userIdParamSchema>,
    @Body({ schema: updateUserSchema }) body: UpdateUser,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      userSchema,
      toApiUser(await this.users.update(params.id, body, principal)),
    );
  }

  @Post(':id/force-logout')
  @HttpCode(200)
  @RequirePermission('session.revoke.any')
  @Audited({ action: AUDIT_ACTIONS.forceLogout, targetType: 'user' })
  @ApiOperation({
    summary: 'End every session of a user (head)',
    description: 'Takes effect on the next request of each session, not when its token expires.',
  })
  @ApiOkResponse({ standardSchema: forceLogoutResultSchema })
  @ApiNotFoundResponse({ description: 'No such user' })
  async forceLogout(
    @Param({ schema: userIdParamSchema }) params: z.infer<typeof userIdParamSchema>,
  ) {
    if (!(await this.users.findById(params.id))) throw notFound('No such user');
    const revokedSessions = await this.sessions.revokeAllForUser(params.id, 'forced_logout');
    AuditScope.set({ targetType: 'user', targetId: params.id, metadata: { revokedSessions } });
    return parseResponse(forceLogoutResultSchema, { revokedSessions });
  }
}
