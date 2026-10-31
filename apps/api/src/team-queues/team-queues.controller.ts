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
  createTeamQueueSchema,
  idParamSchema,
  teamQueueListSchema,
  teamQueueSchema,
  updateTeamQueueSchema,
  type CreateTeamQueue,
  type UpdateTeamQueue,
} from '@watchtower/shared';
import type { z } from 'zod';

import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { TeamQueuesService } from './team-queues.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('queues')
@Controller('v1/queues')
export class TeamQueuesController {
  constructor(@Inject(TeamQueuesService) private readonly queues: TeamQueuesService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'List team queues with their members (staff)' })
  @ApiOkResponse({ standardSchema: teamQueueListSchema })
  async list() {
    return parseResponse(teamQueueListSchema, { queues: await this.queues.list() });
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'One team queue (staff)' })
  @ApiOkResponse({ standardSchema: teamQueueSchema })
  @ApiNotFoundResponse({ description: 'No such queue' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(teamQueueSchema, await this.queues.get(params.id));
  }

  @Post()
  @RequirePermission('queue.manage')
  @Audited({ action: AUDIT_ACTIONS.queueCreate, targetType: 'team_queue' })
  @ApiOperation({
    summary: 'Create a team queue',
    description:
      '`assignmentMode: round_robin` hands new tickets of the queue to its active members in turn. ' +
      'At most one queue is the default; tickets created without a queue go there.',
  })
  @ApiCreatedResponse({ standardSchema: teamQueueSchema })
  @ApiConflictResponse({ description: 'The name is taken' })
  async create(@Body({ schema: createTeamQueueSchema }) body: CreateTeamQueue) {
    return parseResponse(teamQueueSchema, await this.queues.create(body));
  }

  @Patch(':id')
  @RequirePermission('queue.manage')
  @Audited({ action: AUDIT_ACTIONS.queueUpdate, targetType: 'team_queue' })
  @ApiOperation({ summary: 'Edit a team queue; `memberIds` replaces the member list' })
  @ApiOkResponse({ standardSchema: teamQueueSchema })
  @ApiNotFoundResponse({ description: 'No such queue' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateTeamQueueSchema }) body: UpdateTeamQueue,
  ) {
    return parseResponse(teamQueueSchema, await this.queues.update(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('queue.manage')
  @Audited({ action: AUDIT_ACTIONS.queueDelete, targetType: 'team_queue' })
  @ApiOperation({
    summary: 'Delete a team queue',
    description:
      'Refused with 409 while any ticket is still in the queue: move them first. An empty queue is deleted.',
  })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'Tickets still belong to the queue' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.queues.remove(params.id);
  }
}
