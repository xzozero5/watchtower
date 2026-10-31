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
  createIntentSchema,
  idParamSchema,
  intentListSchema,
  intentSchema,
  updateIntentSchema,
  type CreateIntent,
  type UpdateIntent,
} from '@watchtower/shared';
import type { z } from 'zod';

import {
  Audited,
  CurrentPrincipal,
  RequireAnyPermission,
  RequirePermission,
  type Principal,
} from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { IntentsService, toApiIntent } from './intents.service.js';

type IdParam = z.infer<typeof idParamSchema>;

@ApiTags('intents')
@Controller('v1/intents')
export class IntentsController {
  constructor(@Inject(IntentsService) private readonly intents: IntentsService) {}

  @Get()
  @RequireAnyPermission('ticket.read', 'ticket.read.org')
  @ApiOperation({
    summary: 'List intents',
    description:
      'Staff get every intent with its settings. A client gets only the active ones and only ' +
      '`id`, `key`, `name` and `description`: the categories of the submit form.',
  })
  @ApiOkResponse({ standardSchema: intentListSchema })
  async list(@CurrentPrincipal() principal: Principal) {
    const rows = await this.intents.list();
    if (principal.orgScope.kind === 'org') {
      return parseResponse(intentListSchema, {
        intents: rows
          .filter((row) => row.isActive)
          .map((row) => ({
            id: row.id,
            key: row.key,
            name: row.name,
            description: row.description,
          })),
      });
    }
    return parseResponse(intentListSchema, { intents: rows.map(toApiIntent) });
  }

  @Get(':id')
  @RequirePermission('ticket.read')
  @ApiOperation({ summary: 'One intent (staff)' })
  @ApiOkResponse({ standardSchema: intentSchema })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async get(@Param({ schema: idParamSchema }) params: IdParam) {
    return parseResponse(intentSchema, await this.intents.get(params.id));
  }

  @Post()
  @RequirePermission('intent.manage')
  @Audited({ action: AUDIT_ACTIONS.intentCreate, targetType: 'intent' })
  @ApiOperation({
    summary: 'Create an intent',
    description:
      'A new intent starts at autonomy stage 2 (draft-for-approval). The stage cannot be set here; ' +
      'it changes only through the AI autonomy endpoints (N3).',
  })
  @ApiCreatedResponse({ standardSchema: intentSchema })
  @ApiConflictResponse({ description: 'The key is taken' })
  async create(@Body({ schema: createIntentSchema }) body: CreateIntent) {
    return parseResponse(intentSchema, await this.intents.create(body));
  }

  @Patch(':id')
  @RequirePermission('intent.manage')
  @Audited({ action: AUDIT_ACTIONS.intentUpdate, targetType: 'intent' })
  @ApiOperation({ summary: 'Edit an intent (never its key or autonomy stage)' })
  @ApiOkResponse({ standardSchema: intentSchema })
  @ApiNotFoundResponse({ description: 'No such intent' })
  async update(
    @Param({ schema: idParamSchema }) params: IdParam,
    @Body({ schema: updateIntentSchema }) body: UpdateIntent,
  ) {
    return parseResponse(intentSchema, await this.intents.update(params.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('intent.manage')
  @Audited({ action: AUDIT_ACTIONS.intentDelete, targetType: 'intent' })
  @ApiOperation({ summary: 'Delete an intent no ticket uses' })
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiConflictResponse({ description: 'Tickets use this intent; deactivate it instead' })
  async remove(@Param({ schema: idParamSchema }) params: IdParam): Promise<void> {
    await this.intents.remove(params.id);
  }
}
