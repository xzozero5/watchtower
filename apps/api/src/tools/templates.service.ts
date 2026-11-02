import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  ConnectorQueryRejectedError,
  templateInputParams,
  templatePlaceholders,
  validateTemplate,
} from '@watchtower/connectors';
import { schema, type Database } from '@watchtower/db';
import { getToolTemplate, listToolTemplates, type ToolTemplateRecord } from '@watchtower/domain';
import {
  TOOLS_AUDIT_ACTIONS,
  type CreateToolTemplate,
  type ToolTemplate,
  type ToolTemplateListQuery,
  type UpdateToolTemplate,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service.js';
import { badRequest, conflict, notFound } from '../auth/http-errors.js';
import { PG, pgCode, pgConstraint } from '../common/db-errors.js';
import { DATABASE } from '../database/database.module.js';
import { UnitOfWorkService } from '../realtime/unit-of-work.js';

export function toToolTemplate(row: ToolTemplateRecord): ToolTemplate {
  return {
    id: row.id,
    kind: row.kind as ToolTemplate['kind'],
    name: row.name,
    title: row.title,
    intentKey: row.intentKey,
    body: row.body,
    placeholders: templatePlaceholders(row.body),
    inputParams: templateInputParams(row.body),
    allowedColumns: row.allowedColumns,
    runByAi: row.runByAi,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const bodyDigest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

/**
 * The saved queries behind the investigation buttons (T-203d). A template is a query against
 * customer data, so only a head writes one (`integration.manage`), a body that could never run is
 * refused when it is saved, and every change leaves an audit row naming the template and the hash of
 * its body (the body itself holds placeholders and no customer data, and stays in the table).
 */
@Injectable()
export class ToolTemplates {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(UnitOfWorkService) private readonly uow: UnitOfWorkService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(query: ToolTemplateListQuery): Promise<ToolTemplate[]> {
    const rows = await listToolTemplates(this.database.db, {
      ...(query.intent === undefined ? {} : { intentKey: query.intent }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
    });
    return rows.map(toToolTemplate);
  }

  async create(input: CreateToolTemplate, actorId: string): Promise<ToolTemplate> {
    this.check(input.kind, input.body, input.allowedColumns, input.runByAi);
    const id = await this.uow.run(async ({ tx }) => {
      const intentId = await this.intentId(tx, input.intentKey);
      try {
        const [created] = await tx
          .insert(schema.toolTemplate)
          .values({
            kind: input.kind,
            name: input.name,
            title: input.title,
            intentId,
            body: input.body,
            allowedColumns: input.allowedColumns,
            runByAi: input.runByAi,
            active: input.active,
            createdBy: actorId,
            updatedBy: actorId,
          })
          .returning({ id: schema.toolTemplate.id });
        if (created === undefined) throw new Error('tool_template insert returned no row');
        await this.audit.recordInTransaction(tx, {
          actor: { type: 'user', id: actorId },
          action: TOOLS_AUDIT_ACTIONS.toolTemplateCreate,
          targetType: 'tool_template',
          targetId: created.id,
          metadata: {
            kind: input.kind,
            name: input.name,
            intent: input.intentKey,
            bodyDigest: bodyDigest(input.body),
            runByAi: input.runByAi,
          },
        });
        return created.id;
      } catch (error) {
        if (pgCode(error) === PG.uniqueViolation && pgConstraint(error) === 'tool_template_name_key') {
          throw conflict('A template with this kind and name already exists');
        }
        throw error;
      }
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateToolTemplate, actorId: string): Promise<ToolTemplate> {
    const current = await getToolTemplate(this.database.db, id);
    if (current === null) throw notFound('No such template');
    const kind = current.kind as 'logs' | 'data';
    this.check(
      kind,
      input.body ?? current.body,
      input.allowedColumns ?? current.allowedColumns,
      input.runByAi ?? current.runByAi,
    );
    await this.uow.run(async ({ tx }) => {
      const intentId =
        input.intentKey === undefined ? undefined : await this.intentId(tx, input.intentKey);
      const [updated] = await tx
        .update(schema.toolTemplate)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(intentId === undefined ? {} : { intentId }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.allowedColumns === undefined ? {} : { allowedColumns: input.allowedColumns }),
          ...(input.runByAi === undefined ? {} : { runByAi: input.runByAi }),
          ...(input.active === undefined ? {} : { active: input.active }),
          updatedBy: actorId,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(schema.toolTemplate.id, id))
        .returning({ id: schema.toolTemplate.id });
      if (updated === undefined) throw notFound('No such template');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: TOOLS_AUDIT_ACTIONS.toolTemplateUpdate,
        targetType: 'tool_template',
        targetId: id,
        metadata: {
          kind,
          name: current.name,
          fields: Object.keys(input).toSorted(),
          ...(input.body === undefined
            ? {}
            : { bodyDigestBefore: bodyDigest(current.body), bodyDigestAfter: bodyDigest(input.body) }),
        },
      });
    });
    return this.get(id);
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.uow.run(async ({ tx }) => {
      const [removed] = await tx
        .delete(schema.toolTemplate)
        .where(eq(schema.toolTemplate.id, id))
        .returning({ name: schema.toolTemplate.name, kind: schema.toolTemplate.kind });
      if (removed === undefined) throw notFound('No such template');
      await this.audit.recordInTransaction(tx, {
        actor: { type: 'user', id: actorId },
        action: TOOLS_AUDIT_ACTIONS.toolTemplateDelete,
        targetType: 'tool_template',
        targetId: id,
        metadata: { kind: removed.kind, name: removed.name },
      });
    });
  }

  private async get(id: string): Promise<ToolTemplate> {
    const row = await getToolTemplate(this.database.db, id);
    if (row === null) throw notFound('No such template');
    return toToolTemplate(row);
  }

  private check(
    kind: 'logs' | 'data',
    body: string,
    allowedColumns: readonly string[],
    runByAi: boolean,
  ): void {
    // The AI runs a template without a person choosing its parameters, so it must be about the ticket's
    // organization; one that is not can only be for a person to press (runByAi: false).
    if (runByAi && !templatePlaceholders(body).includes('org_id')) {
      throw badRequest('A template the AI runs must use {{org_id}}; set runByAi to false for one that does not');
    }
    if (kind === 'logs' && allowedColumns.length > 0) {
      throw badRequest('allowedColumns is for data templates');
    }
    try {
      validateTemplate(kind, body);
    } catch (error) {
      if (error instanceof ConnectorQueryRejectedError) throw badRequest(error.message);
      throw error;
    }
  }

  private async intentId(
    tx: Pick<Database['db'], 'select'>,
    key: string | null,
  ): Promise<string | null> {
    if (key === null) return null;
    const [row] = await tx
      .select({ id: schema.intent.id })
      .from(schema.intent)
      .where(eq(schema.intent.key, key))
      .limit(1);
    if (row === undefined) throw badRequest('No such intent');
    return row.id;
  }
}
