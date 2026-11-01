import { Module } from '@nestjs/common';

import { KbEmbeddingService } from './kb-embedding.service.js';
import { KbController } from './kb.controller.js';
import { KbService } from './kb.service.js';

/**
 * Knowledge base articles, versions and search (T-107, PRD R-4.1 to R-4.3). The crawler (R-4.3) and
 * the editor UI are separate tasks. Every route needs `@RequirePermission` / `@RequireAnyPermission`
 * or `@Public()`, and a public one must also be listed in `./public-routes.ts` (none here).
 *
 * For whoever builds the client (T-107e): `snippet`, `section`, `title`, `bodyMd` and `sources[].ref`
 * are raw text. Escape them, render Markdown without raw HTML, and link only to http(s) URLs (a
 * `url` source may hold any scheme, `javascript:` included).
 *
 * Publishing is two people: the writer sends an article for review and an approver who wrote none
 * of the text publishes the version and audience they saw. The head can publish break-glass, with a
 * reason, and another approver reviews it afterwards. Only a signed-in person can do either.
 */
@Module({
  controllers: [KbController],
  providers: [KbService, KbEmbeddingService],
  exports: [KbService],
})
export class KbModule {}
