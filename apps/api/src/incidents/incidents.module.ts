import { Module } from '@nestjs/common';

import { NO_REPO_CHANGES, REPO_CHANGES } from './changes.js';
import { DeploysController, IncidentsController } from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

/**
 * Incidents and the deploy feed as staff see them (T-202a, R-3.12, R-5.4). The signed route CI posts
 * deploys to lives with the other machine receivers in `AlertsModule`. Every route needs
 * `@RequirePermission` / `@RequireAnyPermission` or `@Public()`.
 */
@Module({
  controllers: [IncidentsController, DeploysController],
  // No repository is connected in this build: the changes view shows deploys and says repoSource none.
  // A live client (T-203a RepoClient, behind [ASK-HUMAN]) replaces this provider.
  providers: [IncidentsService, { provide: REPO_CHANGES, useValue: NO_REPO_CHANGES }],
  exports: [IncidentsService],
})
export class IncidentsModule {}
