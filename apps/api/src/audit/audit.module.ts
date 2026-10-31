import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditController } from './audit.controller.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';
import { EmailTagService } from './email-tag.service.js';

@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    EmailTagService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService, EmailTagService],
})
export class AuditModule {}
