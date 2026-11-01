import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  integrationFieldParamSchema,
  integrationListSchema,
  integrationParamSchema,
  integrationStatusSchema,
  putCredentialsSchema,
  testConnectionResultSchema,
  testConnectionSchema,
  type IntegrationFieldParam,
  type IntegrationParam,
  type PutCredentials,
  type TestConnection,
} from '@watchtower/shared';

import {
  Audited,
  CurrentPrincipal,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { CredentialsService } from './credentials.service.js';

/**
 * Integration credentials, `head` only (`integration.manage`, ADR-004, ADR-012). Write-only: no
 * response carries a stored value, a mask or a length. Environment variables win over saved values.
 */
@ApiTags('admin')
@Controller('v1/admin/integrations')
@RequirePermission('integration.manage')
export class CredentialsController {
  constructor(@Inject(CredentialsService) private readonly credentials: CredentialsService) {}

  @Get()
  @ApiOperation({
    summary: 'Integrations and whether each field is set (head)',
    description:
      'Every integration with, per field: configured, where the value in effect comes from ' +
      '(`env` wins over `db`; `none` when unset), the variable that would set it, and who saved it ' +
      'and when. Values are never returned.',
  })
  @ApiOkResponse({ standardSchema: integrationListSchema })
  async list() {
    return parseResponse(integrationListSchema, await this.credentials.list());
  }

  @Put(':integration')
  @Audited({ action: AUDIT_ACTIONS.integrationCredentialSet, targetType: 'integration' })
  @ApiOperation({
    summary: 'Save credential fields (head)',
    description:
      'Writes the fields in `fields` (encrypted, write-only) and leaves the others as they are. ' +
      'A field that an environment variable sets is refused with 409. Audited with field names only.',
  })
  @ApiOkResponse({ standardSchema: integrationStatusSchema })
  @ApiBadRequestResponse({ description: 'Unknown field, empty or too long value' })
  @ApiConflictResponse({ description: 'A field is set by an environment variable' })
  async put(
    @Param({ schema: integrationParamSchema }) params: IntegrationParam,
    @Body({ schema: putCredentialsSchema }) body: PutCredentials,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(
      integrationStatusSchema,
      await this.credentials.put(params.integration, body, principal.userId),
    );
  }

  @Delete(':integration/fields/:field')
  @HttpCode(204)
  @Audited({ action: AUDIT_ACTIONS.integrationCredentialDelete, targetType: 'integration' })
  @ApiOperation({ summary: 'Delete a saved credential field (head)' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'Nothing is saved for that field' })
  async remove(
    @Param({ schema: integrationFieldParamSchema }) params: IntegrationFieldParam,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.credentials.remove(params.integration, params.field, principal.userId);
  }

  @Post(':integration/test')
  @HttpCode(200)
  @Audited({ action: AUDIT_ACTIONS.integrationCredentialTest, targetType: 'integration' })
  @ApiOperation({
    summary: 'Test the connection (head)',
    description:
      'Checks the values in effect: environment, then the unsaved `fields` of this request, then ' +
      'the saved ones. With live tests off (the default) the check is an offline fake and nothing ' +
      'leaves the server (`mode: "mock"`). A failed check answers 200 with `ok: false`; the message ' +
      'never contains a value.',
  })
  @ApiOkResponse({ standardSchema: testConnectionResultSchema })
  @ApiBadRequestResponse({ description: 'Unknown field' })
  async test(
    @Param({ schema: integrationParamSchema }) params: IntegrationParam,
    @Body({ schema: testConnectionSchema }) body: TestConnection,
  ) {
    return parseResponse(
      testConnectionResultSchema,
      await this.credentials.test(params.integration, body),
    );
  }
}
