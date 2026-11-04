import { writeWeeklyBrief, type WeeklyBriefFact } from '@watchtower/ai';
import { schema, type Database } from '@watchtower/db';
import {
  CEO_PAGE_HREF,
  SeedTicketFilter,
  TicketKeys,
  currentWeeklySlot,
  figureFacts,
  insertWeeklyBriefDraft,
  readCeoView,
  weeklyBriefExists,
  weeklyBriefFacts,
  weeklySlotInstant,
  type BriefFact,
  type WeeklySlotConfig,
} from '@watchtower/domain';
import {
  WEEKLY_BRIEF_AI_GIVE_UP_HOURS,
  WEEKLY_BRIEF_WINDOW_DAYS,
  makeClaim,
  type CeoView,
  type WeeklyBriefContent,
  type WeeklyBriefDay,
  type WeeklyBriefLocale,
} from '@watchtower/shared';
import { and, inArray, notInArray, eq } from 'drizzle-orm';

import type { WorkerLogger } from '../logger.js';
import { ticketPeopleNames } from './people-names.js';
import type { AiRuntime } from './runtime.js';

export interface WeeklyBriefSettings {
  readonly enabled: boolean;
  readonly day: WeeklyBriefDay;
  readonly time: string;
  readonly timeZone: string;
  readonly locale: WeeklyBriefLocale;
  readonly ticketKeyPrefix: string;
  readonly minutesPerTicket: number;
  readonly staffCostUsdPerHour: number | null;
}

export interface WeeklyBriefDeps {
  readonly database: Database;
  readonly ai: AiRuntime | undefined;
  readonly logger: WorkerLogger;
  readonly settings: WeeklyBriefSettings;
  readonly now?: () => Date;
  /** Failed model attempts per slot, kept between ticks (a restart forgets them: at worst a few more tries). */
  readonly attempts?: Map<string, number>;
}

export type WeeklyBriefResult =
  | { readonly status: 'disabled' }
  | { readonly status: 'exists'; readonly slotDate: string }
  /** The AI host is offline: nothing is stored, the next tick tries again (ADR-019). */
  | { readonly status: 'deferred'; readonly slotDate: string }
  | {
      readonly status: 'drafted';
      readonly slotDate: string;
      readonly source: 'ai' | 'data_only';
      readonly reason?: string;
    };

/** After this many failed answers of the model for one slot, the draft is made from the figures alone. */
export const MAX_MODEL_ATTEMPTS = 3;

/** The summary a person can trust when no model wrote one: the figures of the CEO view, each a claim with its chip. */
function figureContent(view: CeoView, locale: WeeklyBriefLocale): WeeklyBriefContent {
  return {
    summary: figureFacts(view, locale)
      .slice(0, 8)
      .map((fact) =>
        makeClaim(fact.text, [
          { kind: fact.kind, label: fact.label, href: fact.href ?? CEO_PAGE_HREF },
        ]),
      ),
    rootCauses: [],
    decisions: [],
  };
}

const isEmpty = (content: WeeklyBriefContent): boolean =>
  content.summary.length === 0 && content.rootCauses.length === 0 && content.decisions.length === 0;

/**
 * The weekly brief of the CEO view (T-305c, PRD 9.2). The job ticks every few minutes and makes at most one
 * draft per weekly slot (the configured weekday and time in the zone), so a worker that was down at the
 * time makes it when it is back and one that is up makes it once.
 *
 * - The figures are the CEO view's own (`readCeoView`, the same code as the page, seed batches left out);
 *   the root-cause material is read by SQL from this week's intents, incidents and investigation findings.
 *   The model only rewords those facts and cites them by id; it writes no link (T-135, N5).
 * - Everything the model reads is redacted (N4) and goes through the guard and `createAuditedLlm`: one
 *   `ai_run` row with the prompt version, model and cost. The agent has no tool (N2).
 * - AI offline: nothing is stored and the next tick retries, for up to a day; then, like every other
 *   reason the AI cannot write (off, over budget, no key, unusable answers), the draft is made from the
 *   figures alone and says why (`source: data_only`), so the head always gets numbers.
 * - The draft is for a head to edit and publish. Nothing leaves the system from here.
 */
export async function runWeeklyBrief(deps: WeeklyBriefDeps): Promise<WeeklyBriefResult> {
  const { settings } = deps;
  if (!settings.enabled) return { status: 'disabled' };
  const db = deps.database.db;
  const now = (deps.now ?? ((): Date => new Date()))();
  const slotConfig: WeeklySlotConfig = {
    day: settings.day,
    time: settings.time,
    timeZone: settings.timeZone,
  };
  const slotDate = currentWeeklySlot(now, slotConfig);
  if (await weeklyBriefExists(db, slotDate)) return { status: 'exists', slotDate };

  const seed = new SeedTicketFilter(deps.database);
  const view = await readCeoView(db, {
    now,
    days: WEEKLY_BRIEF_WINDOW_DAYS,
    minutesPerTicket: settings.minutesPerTicket,
    staffCostUsdPerHour: settings.staffCostUsdPerHour,
    seed,
  });
  const locale = settings.locale;
  const base = { slotDate, view, locale };
  const dataOnly = async (reason: string): Promise<WeeklyBriefResult> => {
    const { created } = await insertWeeklyBriefDraft(db, {
      ...base,
      source: 'data_only',
      reasonCode: reason,
      content: figureContent(view, locale),
      aiRunId: null,
      promptVersion: null,
      mock: false,
    });
    deps.logger.info({ slotDate, reason, created }, 'weekly brief drafted from the figures only');
    return { status: 'drafted', slotDate, source: 'data_only', reason };
  };

  const runtime = deps.ai;
  if (runtime === undefined) return dataOnly('provider_unavailable');

  const found = await weeklyBriefFacts(db, {
    view,
    locale,
    keys: new TicketKeys(settings.ticketKeyPrefix),
    seed,
  });

  // The people the redactor must know (N4): the instance's staff and the people of the tickets in the facts.
  const staff = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(
      and(eq(schema.users.status, 'active'), notInArray(schema.users.role, ['client', 'system'])),
    )
    .limit(10_001);
  // Fail closed like the daily brief: without the whole list of colleagues nothing is sent to a model.
  if (staff.length > 10_000) return dataOnly('name_dictionary_incomplete');
  const namesByTicket = new Map<string, string[]>();
  if (found.ticketIds.length > 0) {
    const tickets = await db
      .select({
        id: schema.ticket.id,
        orgId: schema.ticket.orgId,
        requesterContactId: schema.ticket.requesterContactId,
      })
      .from(schema.ticket)
      .where(inArray(schema.ticket.id, found.ticketIds));
    for (const ticket of tickets) {
      const people = await ticketPeopleNames(db, ticket);
      if (!people.complete) {
        deps.logger.warn(
          { ticketId: ticket.id },
          'name dictionary incomplete for a weekly brief ticket; the name cues still apply',
        );
      }
      namesByTicket.set(ticket.id, people.names);
    }
  }
  const facts: WeeklyBriefFact[] = found.facts.map((fact: BriefFact) => ({
    kind: fact.kind,
    label: fact.label,
    ...(fact.href === undefined ? {} : { href: fact.href }),
    text: fact.text,
    ...(fact.mock === true ? { mock: true } : {}),
    ...(fact.ticketId === undefined ? {} : { names: namesByTicket.get(fact.ticketId) ?? [] }),
  }));
  const names = [
    ...new Set([...staff.map((row) => row.name), ...facts.flatMap((f) => f.names ?? [])]),
  ];
  const agents = runtime.agentDeps(names);

  const outcome = await writeWeeklyBrief(agents, {
    scope: `weekly-brief:${slotDate}`,
    locale,
    facts,
  });
  const attempts = deps.attempts ?? new Map<string, number>();
  if (outcome.status === 'skipped') return dataOnly(outcome.reason);
  if (outcome.status === 'failed') {
    if (outcome.reason === 'provider_offline') {
      const waited = now.getTime() - weeklySlotInstant(slotDate, slotConfig).getTime();
      if (waited < WEEKLY_BRIEF_AI_GIVE_UP_HOURS * 3_600_000) {
        deps.logger.info({ slotDate }, 'weekly brief waits for the AI host to be online');
        return { status: 'deferred', slotDate };
      }
      return dataOnly('provider_offline');
    }
    const failed = (attempts.get(slotDate) ?? 0) + 1;
    attempts.set(slotDate, failed);
    if (failed < MAX_MODEL_ATTEMPTS) {
      deps.logger.warn(
        { slotDate, reason: outcome.reason, failed },
        'weekly brief attempt failed; the next tick tries again',
      );
      return { status: 'deferred', slotDate };
    }
    return dataOnly(outcome.reason);
  }
  if (isEmpty(outcome.content)) return dataOnly('nothing_to_say');

  const { created } = await insertWeeklyBriefDraft(db, {
    ...base,
    source: 'ai',
    reasonCode: null,
    content: outcome.content,
    aiRunId: outcome.runId,
    promptVersion: outcome.promptVersion,
    mock: outcome.mock,
  });
  deps.logger.info(
    {
      slotDate,
      created,
      claims: outcome.content.summary.length,
      rootCauses: outcome.content.rootCauses.length,
      droppedUncited: outcome.droppedUncited,
    },
    'weekly brief drafted',
  );
  return { status: 'drafted', slotDate, source: 'ai' };
}
