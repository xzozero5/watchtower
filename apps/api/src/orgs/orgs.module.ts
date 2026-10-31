import { Module } from '@nestjs/common';

import { ContactsController, OrganizationsController } from './organizations.controller.js';
import { ContactsService } from './contacts.service.js';
import { OrgDomainResolver } from './org-domain-resolver.js';
import { OrganizationsService } from './organizations.service.js';

/** Organizations and their contacts (PRD section 7), and the domain lookup behind client sign-up. */
@Module({
  controllers: [OrganizationsController, ContactsController],
  providers: [OrganizationsService, ContactsService, OrgDomainResolver],
  exports: [OrganizationsService, ContactsService, OrgDomainResolver],
})
export class OrgsModule {}
