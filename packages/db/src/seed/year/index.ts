import {
  holidaySchema,
  slaTargetsSchema,
  weeklyHoursSchema,
  type BusinessCalendar,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../client.js';
import {
  businessCalendar,
  channelAccount,
  intent,
  slaPolicy,
  teamQueue,
} from '../../schema/ticketing.js';
import { shiftDefinition } from '../../schema/shifts.js';
import { SeedError } from '../common.js';
import type { SeedExecutor } from '../reference.js';
import { INSERT_ORDER, planYear } from './plan.js';
import type { ShiftDef } from './roster.js';
import type { SeedObjectStore } from './s3.js';
import type { PolicyRef, Reference, Row, YearOptions } from './types.js';

export { DEFAULT_YEAR_SEED, DEFAULT_TICKET_TARGET, INSERT_ORDER, planYear } from './plan.js';
export type { PlanYearInput, YearPlanFull } from './plan.js';
export { createSeedObjectStore, s3SettingsFromEnv } from './s3.js';
export type { Reference, Row, YearOptions, YearPlan } from './types.js';

/** The marker of an already loaded scenario: the first organization of the cast. */
export const YEAR_MARKER_ORG = 'Kestrel Freight';

export interface YearSeedOptions extends Omit<YearOptions, 'attachments'> {
  readonly ticketKeyPrefix: string;
  /** Where attachment images go. Without it no attachment row is written (nothing would download). */
  readonly objectStore?: SeedObjectStore | null;
  readonly log?: (message: string) => void;
}

export interface YearSeedResult {
  /** True when the scenario was already there and nothing was written. */
  readonly skipped: boolean;
  readonly rows: Readonly<Record<string, number>>;
  readonly attachmentFiles: number;
}

const BATCH_ROWS = 1500;
const PARTITIONED = ['ticket_event', 'audit_log', 'ai_run', 'incident_timeline'] as const;

/**
 * Month partitions are created by the migrations from the month of the migration forward. A year of
 * history lands before that, so the missing past months are created here, with the same protection
 * as `ensure_monthly_partitions` (no UPDATE, DELETE or TRUNCATE for the application role).
 */
export async function ensurePastPartitions(
  executor: SeedExecutor,
  from: Date,
  to: Date,
): Promise<number> {
  let created = 0;
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    const monthStart = cursor.toISOString().slice(0, 10);
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const monthEnd = next.toISOString().slice(0, 10);
    const suffix = `${String(cursor.getUTCFullYear())}${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const parent of PARTITIONED) {
      const name = `${parent}_p${suffix}`;
      const exists = await executor.execute<{ found: string | null }>(
        sql`SELECT to_regclass(${`public.${name}`})::text AS found`,
      );
      if (exists.rows[0]?.found) continue;
      await executor.execute(
        sql.raw(
          `CREATE TABLE public."${name}" PARTITION OF public."${parent}" FOR VALUES FROM ('${monthStart} 00:00:00+00') TO ('${monthEnd} 00:00:00+00')`,
        ),
      );
      await executor.execute(
        sql.raw(`REVOKE UPDATE, DELETE, TRUNCATE ON public."${name}" FROM watchtower_app, PUBLIC`),
      );
      await executor.execute(
        sql.raw(
          `CREATE TRIGGER "${name}_reject_truncate" BEFORE TRUNCATE ON public."${name}" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()`,
        ),
      );
      created += 1;
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return created;
}

async function findOrCreateChannel(
  executor: SeedExecutor,
  type: 'gmail' | 'line',
  name: string,
): Promise<string> {
  const [found] = await executor
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.type, type))
    .limit(1);
  if (found) return found.id;
  const [inserted] = await executor
    .insert(channelAccount)
    .values({ type, name, health: 'ok' })
    .returning({ id: channelAccount.id });
  if (!inserted) throw new SeedError(`channel account ${name} was not created`);
  return inserted.id;
}

/** Reads what the default seed loaded (calendars, SLA policies, intents, queues, shifts, accounts). */
export async function loadReference(
  executor: SeedExecutor,
  ticketKeyPrefix: string,
): Promise<{ reference: Reference; escalationPolicyId: string | null }> {
  const policies = {} as Record<'gold' | 'silver' | 'standard', PolicyRef>;
  let holidays: string[] = [];
  for (const tier of ['gold', 'silver', 'standard'] as const) {
    const [row] = await executor.select().from(slaPolicy).where(eq(slaPolicy.tier, tier)).limit(1);
    if (!row?.businessCalendarId)
      throw new SeedError(`the ${tier} SLA policy is missing: run the default seed first`);
    const [calendarRow] = await executor
      .select()
      .from(businessCalendar)
      .where(eq(businessCalendar.id, row.businessCalendarId))
      .limit(1);
    if (!calendarRow) throw new SeedError(`the calendar of the ${tier} SLA policy is missing`);
    const calendar: BusinessCalendar = {
      timezone: calendarRow.timezone,
      hours: weeklyHoursSchema.parse(calendarRow.hours),
      holidays: holidaySchema
        .array()
        .parse(calendarRow.holidays)
        .map((h) => h.date),
    };
    policies[tier] = { id: row.id, targets: slaTargetsSchema.parse(row.targets), calendar };
    holidays = calendar.holidays.length > holidays.length ? [...calendar.holidays] : holidays;
  }
  const intents = (await executor.select().from(intent)).map((row) => ({
    id: row.id,
    key: row.key,
    defaultPriority: row.defaultPriority,
    autonomyStage: row.autonomyStage,
  }));
  if (intents.length === 0) throw new SeedError('no intents: run the default seed first');
  const queueRows = await executor
    .select({ id: teamQueue.id, name: teamQueue.name })
    .from(teamQueue);
  const queue = (name: string): string => {
    const found = queueRows.find((q) => q.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new SeedError(`queue ${name} is missing: run the default seed first`);
    return found.id;
  };
  const [portal] = await executor
    .select({ id: channelAccount.id })
    .from(channelAccount)
    .where(eq(channelAccount.type, 'portal'))
    .limit(1);
  if (!portal) throw new SeedError('the portal channel account is missing (migration 0002)');
  const shifts: ShiftDef[] = (
    await executor.select().from(shiftDefinition).where(eq(shiftDefinition.active, true))
  ).map((s) => ({
    id: s.id,
    name: s.name,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    onCall: s.onCall,
  }));
  if (shifts.length < 3)
    throw new SeedError('the starter shifts are missing: run the default seed first');
  const escalation = await executor.execute<{ id: string }>(
    sql`SELECT id FROM escalation_policy WHERE is_default LIMIT 1`,
  );
  return {
    reference: {
      policies,
      intents,
      queues: {
        Support: queue('Support'),
        Integrations: queue('Integrations'),
        Billing: queue('Billing'),
      },
      channelAccounts: {
        gmail: await findOrCreateChannel(executor, 'gmail', 'Support mailbox'),
        line: await findOrCreateChannel(executor, 'line', 'LINE official account'),
        portal: portal.id,
      },
      shifts,
      holidays: new Set(holidays),
      ticketKeyPrefix,
    },
    escalationPolicyId: escalation.rows[0]?.id ?? null,
  };
}

/** One INSERT per batch: the rows travel as one JSON array and are cast to the table's row type in SQL. */
export async function bulkInsert(
  executor: SeedExecutor,
  table: string,
  rows: readonly Row[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0] as Row);
  const identifiers = sql.join(
    columns.map((c) => sql.identifier(c)),
    sql`, `,
  );
  let written = 0;
  for (let index = 0; index < rows.length; index += BATCH_ROWS) {
    const json = JSON.stringify(rows.slice(index, index + BATCH_ROWS));
    try {
      const result = await executor.execute(
        sql`INSERT INTO ${sql.identifier(table)} (${identifiers})
            SELECT ${identifiers} FROM jsonb_populate_recordset(NULL::${sql.identifier(table)}, ${json}::jsonb)
            ON CONFLICT DO NOTHING`,
      );
      written += result.rowCount ?? 0;
    } catch (error) {
      // The driver's message repeats every parameter; the reason is on the cause.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const reason = cause instanceof Error ? cause.message : 'unknown error';
      const detail =
        cause instanceof Error && 'detail' in cause ? ` (${String(cause.detail)})` : '';
      throw new SeedError(`inserting ${table} failed: ${reason}${detail}`);
    }
  }
  return written;
}

/**
 * The one-year scenario: a fictional Tech Ops team that used Watchtower for the 365 days before
 * `now`. Run it after the default seed (it needs the calendars, SLA policies, intents, queues and
 * shifts). One transaction; deterministic for a given `now` and seed; a second run finds its
 * marker organization and writes nothing. To load it again, start from an empty database.
 */
/** More tickets than the default demo seed writes means the database is not a demo one. */
const YEAR_MAX_EXISTING_TICKETS = 100;

export async function seedYear(
  database: Database,
  options: YearSeedOptions,
): Promise<YearSeedResult> {
  const log = options.log ?? (() => undefined);
  const marker = await database.db.execute<{ id: string }>(
    sql`SELECT id FROM organization WHERE lower(name) = lower(${YEAR_MARKER_ORG}) LIMIT 1`,
  );
  if (marker.rows.length > 0) {
    log('one-year scenario is already loaded: nothing to do');
    return { skipped: true, rows: {}, attachmentFiles: 0 };
  }
  // NODE_ENV alone is a weak guard (compose defaults it to development): a database that already
  // holds more tickets than the default demo seed writes is treated as real and left alone.
  const existing = await database.db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ticket`,
  );
  const existingTickets = Number(existing.rows[0]?.n ?? '0');
  if (existingTickets > YEAR_MAX_EXISTING_TICKETS) {
    throw new SeedError(
      `the one-year scenario is demo data: this database already has ${String(existingTickets)} tickets ` +
        `(more than the ${String(YEAR_MAX_EXISTING_TICKETS)} the default seed writes), so it is not loaded here`,
    );
  }

  const { reference, escalationPolicyId } = await loadReference(
    database.db,
    options.ticketKeyPrefix,
  );
  const seq = await database.db.execute<{ n: string }>(
    sql`SELECT nextval('ticket_number_seq')::text AS n`,
  );
  const firstTicketNumber = Number(seq.rows[0]?.n ?? '1');

  const build = (attachments: boolean) =>
    planYear({
      ...options,
      reference,
      attachments,
      firstTicketNumber,
      escalationPolicyId,
    });

  let plan = build(options.objectStore != null);
  let uploaded = 0;
  if (options.objectStore) {
    try {
      for (const file of plan.files) {
        await options.objectStore.put(file.objectKey, file.bytes, file.contentType);
        uploaded += 1;
      }
    } catch (error) {
      log(
        `attachments skipped: object storage did not accept the upload (${error instanceof Error ? error.message : 'unknown error'})`,
      );
      plan = build(false);
      uploaded = 0;
    }
  }

  const start = new Date(options.now.getTime() - 365 * 86_400_000);
  const written: Record<string, number> = {};
  await database.db.transaction(async (tx) => {
    await ensurePastPartitions(tx, start, options.now);
    for (const table of INSERT_ORDER) {
      const rows = plan.tables.get(table) ?? [];
      written[table] = await bulkInsert(tx, table, rows);
      if (table === 'contact') {
        // organization.primary_contact_id points at a contact, which needs the organization first.
        await tx.execute(
          sql`UPDATE organization o SET primary_contact_id = p.contact_id
              FROM jsonb_to_recordset(${JSON.stringify(plan.primaryContacts.map((p) => ({ org_id: p.orgId, contact_id: p.contactId })))}::jsonb)
                AS p(org_id uuid, contact_id uuid)
              WHERE o.id = p.org_id`,
        );
      }
    }
    // The plan used the numbers from `firstTicketNumber`; move the sequence past them.
    const last = (plan.tables.get('ticket') ?? []).reduce(
      (max, row) => Math.max(max, Number(row.number)),
      firstTicketNumber,
    );
    await tx.execute(sql`SELECT setval('ticket_number_seq', ${last})`);
  });
  log(
    `one-year scenario: ${String(written.ticket ?? 0)} tickets, ${String(written.message ?? 0)} messages, ${String(written.kb_article ?? 0)} articles, ${String(written.incident ?? 0)} incidents`,
  );
  return { skipped: false, rows: written, attachmentFiles: uploaded };
}
