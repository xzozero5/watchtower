import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  AUDIT_ACTIONS,
  contactPageSchema,
  contactListQuerySchema,
  contactSchema,
  createContactSchema,
  createOrganizationSchema,
  idParamSchema,
  organizationListQuerySchema,
  organizationPageSchema,
  organizationSchema,
  updateContactSchema,
  updateOrganizationSchema,
  type ContactListQuery,
  type CreateContact,
  type CreateOrganization,
  type OrganizationListQuery,
  type UpdateContact,
  type UpdateOrganization,
} from '@watchtower/shared';
import type { z } from 'zod';

import { AuditScope } from '../audit/audit-scope.js';
import {
  AuditPiiRead,
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { ContactsService } from './contacts.service.js';
import { OrganizationsService } from './organizations.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('organizations')
@Controller('v1/orgs')
export class OrganizationsController {
  constructor(@Inject(OrganizationsService) private readonly orgs: OrganizationsService) {}

  @Get()
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
  @ApiOperation({
    summary: 'List organizations',
    description: 'Staff see every organization; a client sees only their own.',
  })
  @ApiOkResponse({ standardSchema: organizationPageSchema })
  async list(
    @Query({ schema: organizationListQuerySchema }) query: OrganizationListQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(organizationPageSchema, await this.orgs.list(query, principal));
  }

  @Get(':id')
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
  @ApiOperation({
    summary: 'One organization (404 for a client asking about another organization)',
  })
  @ApiOkResponse({ standardSchema: organizationSchema })
  @ApiNotFoundResponse({ description: 'No such organization' })
  async get(
    @Param({ schema: idParamSchema }) params: IdParam,
    @CurrentPrincipal() principal: Principal,
  ) {
    return parseResponse(organizationSchema, await this.orgs.get(params.id, principal));
  }

  @Post()
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.orgCreate, targetType: 'organization' })
  @ApiOperation({
    summary: 'Create an organization',
    description:
      '`domains` are the email domains whose owners may sign in as this organization (magic link). ' +
      'A domain belongs to one organization; public mailbox providers are refused.',
  })
  @ApiCreatedResponse({ standardSchema: organizationSchema })
  @ApiConflictResponse({ description: 'A domain already belongs to another organization' })
  async create(@Body({ schema: createOrganizationSchema }) body: CreateOrganization) {
    return parseResponse(organizationSchema, await this.orgs.create(body));
  }

  @Patch(':id')
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.orgUpdate, targetType: 'organization' })
  @ApiOperation({ summary: 'Edit an organization' })
  @ApiOkResponse({ standardSchema: organizationSchema })
  @ApiNotFoundResponse({ description: 'No such organization' })
  @ApiConflictResponse({ description: 'A domain already belongs to another organization' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateOrganizationSchema }) body: UpdateOrganization,
  ) {
    return parseResponse(organizationSchema, await this.orgs.update(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.orgDelete, targetType: 'organization' })
  @ApiOperation({
    summary: 'Delete an organization that has no contacts, users or tickets',
    description: 'Set `status` to inactive instead when it has history.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'The organization still has contacts, users or tickets' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.orgs.remove(params.id);
  }
}

@ApiTags('contacts')
@Controller('v1/contacts')
export class ContactsController {
  constructor(@Inject(ContactsService) private readonly contacts: ContactsService) {}

  @Get()
  @RequirePermission('ticket.read')
  @AuditPiiRead('contact')
  @ApiOperation({
    summary: 'Search contacts (staff)',
    description: 'Every read of contacts is on the audit log (`pii.read`).',
  })
  @ApiOkResponse({ standardSchema: contactPageSchema })
  async list(@Query({ schema: contactListQuerySchema }) query: ContactListQuery) {
    return parseResponse(contactPageSchema, await this.contacts.list(query));
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @AuditPiiRead('contact')
  @ApiOperation({ summary: 'One contact (staff)' })
  @ApiOkResponse({ standardSchema: contactSchema })
  @ApiNotFoundResponse({ description: 'No such contact' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    AuditScope.set({ targetId: params.id });
    return parseResponse(contactSchema, await this.contacts.get(params.id));
  }

  @Post()
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.contactCreate, targetType: 'contact' })
  @ApiOperation({ summary: 'Create a contact of an organization' })
  @ApiCreatedResponse({ standardSchema: contactSchema })
  @ApiConflictResponse({ description: 'An address already belongs to another contact' })
  async create(@Body({ schema: createContactSchema }) body: CreateContact) {
    return parseResponse(contactSchema, await this.contacts.create(body));
  }

  @Patch(':id')
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.contactUpdate, targetType: 'contact' })
  @ApiOperation({ summary: 'Edit a contact' })
  @ApiOkResponse({ standardSchema: contactSchema })
  @ApiNotFoundResponse({ description: 'No such contact' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateContactSchema }) body: UpdateContact,
  ) {
    return parseResponse(contactSchema, await this.contacts.update(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('org.manage')
  @Audited({ action: AUDIT_ACTIONS.contactDelete, targetType: 'contact' })
  @ApiOperation({
    summary: 'Delete a contact',
    description:
      'Refused with 409 while any ticket or message still points at the contact (history is not rewritten); erasing a person for PDPA is a separate process.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'Tickets or messages still reference the contact' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.contacts.remove(params.id);
  }
}
