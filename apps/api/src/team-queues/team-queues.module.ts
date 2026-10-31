import { Module } from '@nestjs/common';

import { AssignmentService } from './assignment.service.js';
import { TeamQueuesController } from './team-queues.controller.js';
import { TeamQueuesService } from './team-queues.service.js';

/** Team queues and round-robin assignment (R-1.7). */
@Module({
  controllers: [TeamQueuesController],
  providers: [TeamQueuesService, AssignmentService],
  exports: [TeamQueuesService, AssignmentService],
})
export class TeamQueuesModule {}
