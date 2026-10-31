import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ApiConflictResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  rolePermissionsListSchema,
  rolePermissionsSchema,
  roleParamSchema,
  setRolePermissionsSchema,
  type SetRolePermissions,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { RbacService } from './rbac.service.js';

@ApiTags('rbac')
@Controller('v1/rbac')
export class RbacController {
  constructor(@Inject(RbacService) private readonly rbac: RbacService) {}

  @Get('roles')
  @RequirePermission('rbac.manage')
  @ApiOperation({
    summary: 'List roles with their permissions, and the catalog of permission strings',
  })
  @ApiOkResponse({ standardSchema: rolePermissionsListSchema })
  async roles() {
    return parseResponse(rolePermissionsListSchema, {
      roles: await this.rbac.listRoles(),
      catalog: this.rbac.catalog(),
    });
  }

  @Put('roles/:role/permissions')
  @RequirePermission('rbac.manage')
  @Audited({ action: AUDIT_ACTIONS.rolePermissionsSet, targetType: 'role' })
  @ApiOperation({
    summary: 'Replace the permissions of a role',
    description:
      'Takes effect within seconds, no deploy. The head role must keep rbac.manage, user.manage, ' +
      'audit.read and session.revoke.any (409 otherwise).',
  })
  @ApiOkResponse({ standardSchema: rolePermissionsSchema })
  @ApiConflictResponse({ description: 'Would remove a permission the head role must keep' })
  async setPermissions(
    @Param({ schema: roleParamSchema }) params: z.infer<typeof roleParamSchema>,
    @Body({ schema: setRolePermissionsSchema }) body: SetRolePermissions,
  ) {
    const { before, after } = await this.rbac.setRolePermissions(params.role, body.permissions);
    AuditScope.set({ targetId: params.role, before, after });
    return parseResponse(rolePermissionsSchema, { role: params.role, permissions: after });
  }
}
