import { Module } from '@nestjs/common';

import { KbEmbeddingService } from './kb-embedding.service.js';
import { KbController } from './kb.controller.js';
import { KbService } from './kb.service.js';

/**
 * Knowledge base articles, versions and search (T-107, PRD R-4.1 to R-4.3). The crawler (R-4.3) and
 * the editor UI are separate tasks. Every route needs `@RequirePermission` / `@RequireAnyPermission`
 * or `@Public()`, and a public one must also be listed in `./public-routes.ts` (none here).
 */
@Module({
  controllers: [KbController],
  providers: [KbService, KbEmbeddingService],
  exports: [KbService],
})
export class KbModule {}
