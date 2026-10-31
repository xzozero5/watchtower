import { Controller, Get, Inject, Injectable, Put, Body } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  TICKET_STATUSES,
  setWorkflowSchema,
  ticketStatusSchema,
  workflowSchema,
  type SetWorkflow,
  type StatusTransition,
  type TicketStatus,
} from '@watchtower/shared';

import { AuditScope } from '../audit/audit-scope.js';
import { Audited, RequirePermission } from '../auth/decorators.js';
import { parseResponse } from '../common/zod-openapi.js';
import { DATABASE } from '../database/database.module.js';

/** Transitions are cached this long; a change made on another instance shows up within it. */
const CACHE_TTL_MS = 5000;

/**
 * Which status changes are allowed (R-1.2). The rules live in `ticket_status_transition`, seeded
 * from `DEFAULT_STATUS_TRANSITIONS`, and a head can change them without a deploy. Two rules are
 * not configurable: a ticket becomes `merged` only through the merge endpoint, and a merged ticket
 * never leaves that status (`setWorkflowSchema` refuses both).
 */
@Injectable()
export class WorkflowService {
  private cache: { readonly at: number; readonly allowed: ReadonlySet<string> } | null = null;

  constructor(@Inject(DATABASE) private readonly database: Database) {}

  private static key(from: string, to: string): string {
    return `${from}>${to}`;
  }

  private async load(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.allowed;
    const rows = await this.database.db.select().from(schema.ticketStatusTransition);
    const allowed = new Set(rows.map((row) => WorkflowService.key(row.fromStatus, row.toStatus)));
    this.cache = { at: now, allowed };
    return allowed;
  }

  async allows(from: TicketStatus, to: TicketStatus): Promise<boolean> {
    return (await this.load()).has(WorkflowService.key(from, to));
  }

  async list(): Promise<StatusTransition[]> {
    this.cache = null;
    const allowed = await this.load();
    return TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => allowed.has(WorkflowService.key(from, to))).map(
        (to): StatusTransition => ({ from, to }),
      ),
    );
  }

  async set(
    input: SetWorkflow,
  ): Promise<{ before: StatusTransition[]; after: StatusTransition[] }> {
    const before = await this.list();
    await this.database.db.transaction(async (tx) => {
      await tx.delete(schema.ticketStatusTransition);
      if (input.transitions.length > 0) {
        await tx.insert(schema.ticketStatusTransition).values(
          input.transitions.map((transition) => ({
            fromStatus: transition.from,
            toStatus: transition.to,
          })),
        );
      }
    });
    this.cache = null;
    return { before, after: await this.list() };
  }
}

@ApiTags('tickets')
@Controller('v1/ticket-workflow')
export class WorkflowController {
  constructor(@Inject(WorkflowService) private readonly workflow: WorkflowService) {}

  @Get()
  @RequirePermission('ticket.read')
  @ApiOperation({
    summary: 'The allowed ticket status transitions (staff)',
    description: `Statuses: ${ticketStatusSchema.options.join(', ')}.`,
  })
  @ApiOkResponse({ standardSchema: workflowSchema })
  async get() {
    return parseResponse(workflowSchema, { transitions: await this.workflow.list() });
  }

  @Put()
  @RequirePermission('workflow.manage')
  @Audited({ action: AUDIT_ACTIONS.workflowSet, targetType: 'ticket_workflow' })
  @ApiOperation({
    summary: 'Replace the allowed ticket status transitions (head)',
    description:
      'Takes effect within a few seconds on every instance. `merged` cannot be part of it: a ticket ' +
      'becomes merged only through the merge endpoint and never leaves that status.',
  })
  @ApiOkResponse({ standardSchema: workflowSchema })
  async set(@Body({ schema: setWorkflowSchema }) body: SetWorkflow) {
    const { before, after } = await this.workflow.set(body);
    AuditScope.set({ before: { transitions: before }, after: { transitions: after } });
    return parseResponse(workflowSchema, { transitions: after });
  }
}
