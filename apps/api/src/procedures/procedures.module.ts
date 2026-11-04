import { Module } from '@nestjs/common';

import { AiRuntimeModule } from '../ai/ai-runtime.module.js';
import { ProceduresController } from './procedures.controller.js';
import { ProceduresService } from './procedures.service.js';

/**
 * Procedures per intent (T-303b, ADR-026): routes under `/v1/intents/:id/procedure/versions`. The rules
 * are in `@watchtower/domain`, the compiler is the `procedure_compiler` agent of `@watchtower/ai`, run
 * through the api's audited, guarded runtime. Every route needs `@RequirePermission` (none is public).
 */
@Module({
  imports: [AiRuntimeModule],
  controllers: [ProceduresController],
  providers: [ProceduresService],
})
export class ProceduresModule {}
