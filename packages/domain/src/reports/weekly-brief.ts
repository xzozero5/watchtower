import { schema, type Database } from '@watchtower/db';
import {
  ceoViewSchema,
  parseWeeklyBriefTime,
  weeklyBriefContentSchema,
  weeklyBriefSchema,
  type CeoView,
  type WeeklyBrief,
  type WeeklyBriefContent,
  type WeeklyBriefDay,
  type WeeklyBriefLocale,
} from '@watchtower/shared';
import { desc, eq } from 'drizzle-orm';

type Db = Database['db'];
type BriefRow = typeof schema.weeklyBrief.$inferSelect;

export interface WeeklySlotConfig {
  readonly day: WeeklyBriefDay;
  /** `HH:MM` on a 24-hour clock in `timeZone`. */
  readonly time: string;
  /** An IANA zone, for example `Asia/Bangkok`. */
  readonly timeZone: string;
}

const DAY_INDEX: Readonly<Record<WeeklyBriefDay, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * The weekly slot `now` falls in: the local date of the most recent occurrence of (day, time) in the zone that
 * is not later than `now`. One brief is made per slot, so a worker that was down at the due time makes it when it
 * is back, and one that is up makes it once. Throws on a time or zone that does not exist (a config error).
 */
export function currentWeeklySlot(now: Date, config: WeeklySlotConfig): string {
  const minutes = parseWeeklyBriefTime(config.time);
  if (minutes === null) throw new Error('the weekly brief time must be HH:MM');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'));
  const weekday = new Date(local).getUTCDay();
  const nowMinutes = get('hour') * 60 + get('minute');
  let back = (weekday - DAY_INDEX[config.day] + 7) % 7;
  if (back === 0 && nowMinutes < minutes) back = 7;
  return new Date(local - back * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instant of a slot: `slotDate` at `config.time` in the zone. Off by an hour at most on the one night a
 * clock change falls in the hour in question; the only use is "how long has this slot been waiting".
 */
export function weeklySlotInstant(slotDate: string, config: WeeklySlotConfig): Date {
  const minutes = parseWeeklyBriefTime(config.time);
  if (minutes === null) throw new Error('the weekly brief time must be HH:MM');
  const guess = Date.parse(`${slotDate}T${config.time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(guess));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
  );
  return new Date(guess - (localAsUtc - guess));
}

/** The row as the api and the page read it. `aiContent` only for a person who may edit. */
export function toWeeklyBrief(row: BriefRow, options: { includeAi: boolean }): WeeklyBrief {
  return weeklyBriefSchema.parse({
    id: row.id,
    slotDate: row.slotDate,
    periodFrom: row.periodFrom.toISOString(),
    periodTo: row.periodTo.toISOString(),
    status: row.status,
    locale: row.locale,
    source: row.source,
    reasonCode: row.reasonCode,
    figures: ceoViewSchema.parse(row.figures),
    content: weeklyBriefContentSchema.parse(row.content),
    aiContent: options.includeAi ? weeklyBriefContentSchema.parse(row.aiContent) : null,
    mock: row.mock,
    aiRunId: row.aiRunId,
    promptVersion: row.promptVersion,
    editedAt: row.editedAt?.toISOString() ?? null,
    recipients: row.recipients,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });
}

export async function weeklyBriefExists(db: Db, slotDate: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.weeklyBrief.id })
    .from(schema.weeklyBrief)
    .where(eq(schema.weeklyBrief.slotDate, slotDate))
    .limit(1);
  return rows.length > 0;
}

export interface NewWeeklyBrief {
  readonly slotDate: string;
  readonly view: CeoView;
  readonly locale: WeeklyBriefLocale;
  readonly source: 'ai' | 'data_only';
  readonly reasonCode: string | null;
  readonly content: WeeklyBriefContent;
  readonly aiRunId: string | null;
  readonly promptVersion: number | null;
  readonly mock: boolean;
}

/**
 * Stores the draft of one slot. A second insert for the same slot changes nothing and answers `created: false`
 * (two workers, or a retry after the first one committed).
 */
export async function insertWeeklyBriefDraft(
  db: Db,
  input: NewWeeklyBrief,
): Promise<{ created: boolean }> {
  const content = weeklyBriefContentSchema.parse(input.content);
  const rows = await db
    .insert(schema.weeklyBrief)
    .values({
      slotDate: input.slotDate,
      periodFrom: new Date(input.view.window.from),
      periodTo: new Date(input.view.window.to),
      locale: input.locale,
      source: input.source,
      reasonCode: input.reasonCode,
      figures: ceoViewSchema.parse(input.view),
      content,
      aiContent: content,
      aiRunId: input.aiRunId,
      promptVersion: input.promptVersion,
      mock: input.mock,
    })
    .onConflictDoNothing({ target: schema.weeklyBrief.slotDate })
    .returning({ id: schema.weeklyBrief.id });
  return { created: rows.length > 0 };
}

export async function latestPublishedWeeklyBrief(db: Db): Promise<BriefRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.weeklyBrief)
    .where(eq(schema.weeklyBrief.status, 'published'))
    .orderBy(desc(schema.weeklyBrief.publishedAt), desc(schema.weeklyBrief.slotDate))
    .limit(1);
  return row;
}

export async function latestDraftWeeklyBrief(db: Db): Promise<BriefRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.weeklyBrief)
    .where(eq(schema.weeklyBrief.status, 'draft'))
    .orderBy(desc(schema.weeklyBrief.slotDate))
    .limit(1);
  return row;
}
