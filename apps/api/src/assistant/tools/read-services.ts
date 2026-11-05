import { Inject, Injectable } from '@nestjs/common';

import { AutonomyService } from '../../autonomy/autonomy.service.js';
import { CredentialsService } from '../../credentials/credentials.service.js';
import { DashboardService } from '../../dashboard/dashboard.service.js';
import { OtherMailService } from '../../inbound/other-mail.service.js';
import { IntentsService } from '../../intents/intents.service.js';
import { KbService } from '../../kb/kb.service.js';
import { CeoViewService } from '../../reports/ceo-view.service.js';
import { SlaAdminService } from '../../sla/sla-admin.service.js';
import { TeamQueuesService } from '../../team-queues/team-queues.service.js';
import { WorkflowService } from '../../tickets/workflow.service.js';
import { TicketReader } from '../../tickets/ticket-reader.js';
import { TimelineService } from '../../tickets/timeline.service.js';

/**
 * The readers and services that the module read tools of stage 1 wrap (ADR-029 section 2, T-404, T-405): the very
 * ones the GET routes of those modules use, so the screen and the assistant read one set of data (N6). Held in one
 * object so `AssistantToolDeps` takes one optional field and a test fakes what it needs.
 */
export interface ModuleReadServices {
  readonly reader: Pick<TicketReader, 'viewRow'>;
  readonly dashboard: Pick<DashboardService, 'ops' | 'performance'>;
  readonly ceo: Pick<CeoViewService, 'read'>;
  readonly otherMail: Pick<OtherMailService, 'list' | 'get'>;
  readonly kb: Pick<KbService, 'get'>;
  readonly timeline: Pick<TimelineService, 'timeline'>;
  readonly autonomy: Pick<AutonomyService, 'read' | 'promotionState'>;
  readonly sla: Pick<SlaAdminService, 'listPolicies'>;
  readonly queues: Pick<TeamQueuesService, 'list'>;
  readonly intents: Pick<IntentsService, 'list'>;
  readonly workflow: Pick<WorkflowService, 'list'>;
  readonly credentials: Pick<CredentialsService, 'list'>;
}

@Injectable()
export class AssistantReadServices implements ModuleReadServices {
  constructor(
    @Inject(TicketReader) readonly reader: TicketReader,
    @Inject(DashboardService) readonly dashboard: DashboardService,
    @Inject(CeoViewService) readonly ceo: CeoViewService,
    @Inject(OtherMailService) readonly otherMail: OtherMailService,
    @Inject(KbService) readonly kb: KbService,
    @Inject(TimelineService) readonly timeline: TimelineService,
    @Inject(AutonomyService) readonly autonomy: AutonomyService,
    @Inject(SlaAdminService) readonly sla: SlaAdminService,
    @Inject(TeamQueuesService) readonly queues: TeamQueuesService,
    @Inject(IntentsService) readonly intents: IntentsService,
    @Inject(WorkflowService) readonly workflow: WorkflowService,
    @Inject(CredentialsService) readonly credentials: CredentialsService,
  ) {}
}
