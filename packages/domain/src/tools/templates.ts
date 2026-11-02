import { schema, type Database } from '@watchtower/db';
import type { ToolKind } from '@watchtower/shared';
import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

/**
 * Reads of the saved investigation templates (T-203d). Writing them is a head's act with its own
 * audit row and lives in the API; here are the reads that the API (buttons) and the worker (the
 * AI's tools) share, so both pick the same template for the same intent.
 */

export type ToolTemplateRecord = typeof schema.toolTemplate.$inferSelect & {
  /** The key of the intent the template belongs to, or null for a generic one. */
  readonly intentKey: string | null;
};

type Reader = Pick<Database['db'], 'select'>;

const columns = {
  id: schema.toolTemplate.id,
  kind: schema.toolTemplate.kind,
  name: schema.toolTemplate.name,
  title: schema.toolTemplate.title,
  intentId: schema.toolTemplate.intentId,
  body: schema.toolTemplate.body,
  allowedColumns: schema.toolTemplate.allowedColumns,
  runByAi: schema.toolTemplate.runByAi,
  active: schema.toolTemplate.active,
  createdBy: schema.toolTemplate.createdBy,
  updatedBy: schema.toolTemplate.updatedBy,
  createdAt: schema.toolTemplate.createdAt,
  updatedAt: schema.toolTemplate.updatedAt,
  intentKey: schema.intent.key,
};

function select(db: Reader, where: SQL | undefined) {
  return db
    .select(columns)
    .from(schema.toolTemplate)
    .leftJoin(schema.intent, eq(schema.intent.id, schema.toolTemplate.intentId))
    .where(where)
    .orderBy(asc(schema.toolTemplate.kind), asc(schema.toolTemplate.name));
}

export async function getToolTemplate(db: Reader, id: string): Promise<ToolTemplateRecord | null> {
  const [row] = await select(db, eq(schema.toolTemplate.id, id)).limit(1);
  return row ?? null;
}

export async function listToolTemplates(
  db: Reader,
  filter: { readonly intentKey?: string; readonly kind?: ToolKind } = {},
): Promise<ToolTemplateRecord[]> {
  const conditions: SQL[] = [];
  if (filter.intentKey !== undefined) conditions.push(eq(schema.intent.key, filter.intentKey));
  if (filter.kind !== undefined) conditions.push(eq(schema.toolTemplate.kind, filter.kind));
  return select(db, conditions.length === 0 ? undefined : and(...conditions));
}

/**
 * The templates a person sees as buttons on a ticket: the active ones of the ticket's intent, then the
 * active generic ones. With no intent only the generic ones.
 */
export async function templatesForTicket(
  db: Reader,
  intentKey: string | null,
): Promise<ToolTemplateRecord[]> {
  const generic = isNull(schema.toolTemplate.intentId);
  const rows = await select(
    db,
    and(
      eq(schema.toolTemplate.active, true),
      intentKey === null ? generic : or(generic, eq(schema.intent.key, intentKey)),
    ),
  );
  // The intent's own first.
  return rows.toSorted((a, b) => Number(a.intentKey === null) - Number(b.intentKey === null));
}

/**
 * The template the AI runs for an intent and a kind: the first active one marked `run_by_ai`, by name.
 * A generic template is never run by the AI, because its scope would not come from an intent
 * (SR106-R8). Null when the intent has none.
 */
export async function templateForAi(
  db: Reader,
  intentKey: string,
  kind: ToolKind,
): Promise<ToolTemplateRecord | null> {
  const [row] = await select(
    db,
    and(
      eq(schema.intent.key, intentKey),
      eq(schema.toolTemplate.kind, kind),
      eq(schema.toolTemplate.active, true),
      eq(schema.toolTemplate.runByAi, true),
      // Only a template about the ticket's organization (also a CHECK of the table).
      sql`position('{{org_id}}' in ${schema.toolTemplate.body}) > 0`,
    ),
  ).limit(1);
  return row ?? null;
}
