import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DEFAULT_WEEKLY_HOURS,
  holidayFileSchema,
  slaPolicyFileSchema,
  type HolidayFile,
  type SlaPolicyFile,
} from '@watchtower/shared';
import { eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { businessCalendar, slaPolicy } from '../schema/ticketing.js';
import { SeedError, readJsonFile } from './common.js';

/** A transaction or the database: the seed runs everything in one transaction. */
export type SeedExecutor = Pick<Database['db'], 'select' | 'insert' | 'update' | 'execute'>;

/** Name of the calendar that counts every hour of every day. */
export const CALENDAR_24X7 = '24x7';

export interface ReferenceSeedResult {
  readonly calendars: { readonly created: string[]; readonly existing: string[] };
  readonly policies: { readonly created: string[]; readonly existing: string[] };
}

async function jsonFilesOf(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((file) => file.endsWith('.json')).toSorted();
}

/**
 * Reads and validates every holiday file of a directory (`examples/calendars`). Two files that
 * name the same calendar are refused: it would be unclear which list wins.
 */
export async function loadHolidayFiles(dir: string): Promise<HolidayFile[]> {
  const files: HolidayFile[] = [];
  const names = new Set<string>();
  for (const file of await jsonFilesOf(dir)) {
    const parsed = await readJsonFile(join(dir, file), holidayFileSchema);
    const name = parsed.calendar.name.toLowerCase();
    if (names.has(name)) {
      throw new SeedError(`${file} repeats the calendar "${parsed.calendar.name}"`);
    }
    names.add(name);
    files.push(parsed);
  }
  return files;
}

/** Reads and validates the SLA policy files of a directory (`examples/sla`). */
export async function loadSlaPolicyFiles(dir: string): Promise<SlaPolicyFile[]> {
  const files: SlaPolicyFile[] = [];
  for (const file of await jsonFilesOf(dir)) {
    files.push(await readJsonFile(join(dir, file), slaPolicyFileSchema));
  }
  const seen = new Set<string>();
  for (const policy of files.flatMap((file) => file.policies)) {
    const keys = [`name:${policy.name.toLowerCase()}`, `tier:${policy.tier}`];
    for (const key of keys) {
      if (seen.has(key)) throw new SeedError(`two SLA policies share the ${key.replace(':', ' ')}`);
      seen.add(key);
    }
  }
  return files;
}

const UNCHECKED = { checked: false, checkedAt: null, checkedBy: null } as const;

const ALL_DAY = [{ start: '00:00', end: '24:00' }];

/**
 * Creates the calendars: one per holiday file (Monday to Friday 09:00 to 18:00 with that file's
 * holidays) and a `24x7` one. A calendar whose name exists is left alone, so edits made in a running
 * instance survive a re-seed. The first calendar created becomes the default if none is.
 */
export async function seedCalendars(
  executor: SeedExecutor,
  holidayFiles: readonly HolidayFile[],
): Promise<ReferenceSeedResult['calendars']> {
  const created: string[] = [];
  const existing: string[] = [];
  let hasDefault =
    (
      await executor
        .select({ id: businessCalendar.id })
        .from(businessCalendar)
        .where(eq(businessCalendar.isDefault, true))
        .limit(1)
    ).length > 0;

  const definitions = [
    ...holidayFiles.map((file) => ({
      name: file.calendar.name,
      timezone: file.calendar.timezone,
      hours: DEFAULT_WEEKLY_HOURS,
      // Example data is `[VERIFY]`: every date starts unchecked until a person compares it with the
      // official announcement (T-127, migration 0009).
      holidays: file.holidays.map((holiday) => ({
        date: holiday.date,
        name: holiday.name,
        ...UNCHECKED,
      })),
    })),
    {
      name: CALENDAR_24X7,
      timezone: 'Asia/Bangkok',
      hours: {
        sun: ALL_DAY,
        mon: ALL_DAY,
        tue: ALL_DAY,
        wed: ALL_DAY,
        thu: ALL_DAY,
        fri: ALL_DAY,
        sat: ALL_DAY,
      },
      holidays: [] as { date: string; name: string }[],
    },
  ];
  for (const definition of definitions) {
    const [found] = await executor
      .select({ id: businessCalendar.id })
      .from(businessCalendar)
      .where(sql`lower(${businessCalendar.name}) = lower(${definition.name})`)
      .limit(1);
    if (found) {
      existing.push(definition.name);
      continue;
    }
    await executor.insert(businessCalendar).values({
      name: definition.name,
      timezone: definition.timezone,
      hours: definition.hours,
      holidays: definition.holidays,
      isDefault: !hasDefault && definition.name !== CALENDAR_24X7,
    });
    if (!hasDefault && definition.name !== CALENDAR_24X7) hasDefault = true;
    created.push(definition.name);
  }
  return { created, existing };
}

/**
 * Creates the tier SLA policies. A policy whose name or tier already exists is left alone. Needs
 * the calendars first (a policy names the calendar it counts business time on). The tier must exist
 * in `org_tier` (migration 0003 seeds gold, silver and standard).
 */
export async function seedSlaPolicies(
  executor: SeedExecutor,
  policyFiles: readonly SlaPolicyFile[],
): Promise<ReferenceSeedResult['policies']> {
  const created: string[] = [];
  const existing: string[] = [];
  for (const policy of policyFiles.flatMap((file) => file.policies)) {
    const [calendar] = await executor
      .select({ id: businessCalendar.id })
      .from(businessCalendar)
      .where(sql`lower(${businessCalendar.name}) = lower(${policy.calendar})`)
      .limit(1);
    if (!calendar) {
      throw new SeedError(
        `SLA policy "${policy.name}" names the unknown calendar "${policy.calendar}"`,
      );
    }
    const [found] = await executor
      .select({ id: slaPolicy.id })
      .from(slaPolicy)
      .where(
        sql`lower(${slaPolicy.name}) = lower(${policy.name}) OR ${slaPolicy.tier} = ${policy.tier}`,
      )
      .limit(1);
    if (found) {
      existing.push(policy.name);
      continue;
    }
    await executor.insert(slaPolicy).values({
      name: policy.name,
      tier: policy.tier,
      targets: policy.targets,
      businessCalendarId: calendar.id,
    });
    created.push(policy.name);
  }
  return { created, existing };
}
