import { Global, Module } from '@nestjs/common';

import { RbacController } from './rbac.controller.js';
import { RbacService } from './rbac.service.js';

@Global()
@Module({
  controllers: [RbacController],
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
