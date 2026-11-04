import { schema, type Database } from '@watchtower/db';
import {
  AUDIT_ACTIONS,
  CSAT_CONTACT_COOLDOWN_DAYS,
  CSAT_COOLDOWN_MAX_DAYS,
  CSAT_COOLDOWN_SETTING_KEY,
  CSAT_DELAY_DEFAULT_MINUTES,
  CSAT_DELAY_MAX_MINUTES,
  CSAT_DELAY_SETTING_KEY,
  CSAT_ENABLED_SETTING_KEY,
  CSAT_LINK_TTL_DAYS,
  CSAT_REMINDER_AFTER_HOURS,
  CSAT_REMINDER_MAX_HOURS,
  CSAT_REMINDER_SETTING_KEY,
  DEFAULT_PORTAL_LOCALE,
  EMAIL_JOBS,
  EMAIL_OUTBOX_JOB_OPTIONS,
  PORTAL_EMAIL_TTL_SECONDS,
  QUEUE_NAMES,
  TICKET_EVENT_TYPES,
  csatSurveyUrl,
  portalLocaleSchema,
  splitEmailSecrets,
  type CsatReason,
  type CsatSettings,
  type CsatSettingsUpdate,
  type PortalLocale,
} from '@watchtower/shared';
import { and, asc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm';

import { recordAuditInTx } from '../audit.js';
import { conflict, notFound } from '../errors.js';
import { enqueueJob } from '../outbox.js';
import type { ContactRow, TicketRow } from '../rows.js';
import { applyStatus } from '../tickets/status.js';
import { recordTicketEvent, ticketEvent, ticketKeysOf } from '../tickets/support.js';
import {
  Effects,
  type DbTransaction,
  type DomainContext,
  type DomainResult,
  type ReadExecutor,
} from '../types.js';
import { decideCsatReopen } from './reopen.js';
import { mintCsatToken, wholeSeconds } from './token.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Channels whose customers get the survey by email. LINE tickets get a LINE message instead (R-10.3,
 * T-110c, after T-113), so for now they get none. Discord and webhook tickets are machine or
 * internal traffic: never surveyed (R-10.4).
 */
const EMAIL_SURVEY_CHANNELS: readonly string[] = ['portal', 'gmail'];

type Executor = DbTransaction;

function csatConfig(ctx: DomainContext): NonNullable<DomainContext['config']['csat']> {
  const csat = ctx.config.csat;
  if (csat === undefined) throw new Error('CSAT is not configured in this process');
  return csat;
}

/** Minutes between "resolved" and the survey. A missing or damaged setting falls back to the default (R-10.1). */
export async function readCsatDelayMinutes(db: ReadExecutor): Promise<number> {
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(eq(schema.instanceSetting.key, CSAT_DELAY_SETTING_KEY))
    .limit(1);
  const value = row?.value;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= CSAT_DELAY_MAX_MINUTES
    ? value
    : CSAT_DELAY_DEFAULT_MINUTES;
}

/** Changes the delay (0 to 10080 minutes). The caller needs the permission to manage the instance; audited. */
export async function setCsatDelayMinutes(
  tx: DbTransaction,
  ctx: DomainContext,
  minutes: number,
): Promise<DomainResult<{ delayMinutes: number }>> {
  const fx = new Effects();
  const before = await readCsatDelayMinutes(tx);
  const updated = await tx
    .update(schema.instanceSetting)
    .set({ value: minutes, updatedBy: ctx.actor.id, updatedAt: ctx.now() })
    .where(eq(schema.instanceSetting.key, CSAT_DELAY_SETTING_KEY))
    .returning({ key: schema.instanceSetting.key });
  if (updated.length === 0) throw new Error('instance_setting row for the CSAT delay is missing');
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.csatSettingSet,
    targetType: 'instance_setting',
    targetId: null,
    before: { delayMinutes: before },
    after: { delayMinutes: minutes },
  });
  return fx.result({ delayMinutes: minutes });
}

async function readSettingValue(db: ReadExecutor, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: schema.instanceSetting.value })
    .from(schema.instanceSetting)
    .where(eq(schema.instanceSetting.key, key))
    .limit(1);
  return row?.value;
}

const wholeBetween = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

/**
 * Every CSAT setting (T-174). A missing or damaged row reads as its default (survey on, one hour,
 * a reminder after 48 hours, one survey per contact per 7 days: R-10.1, R-10.4).
 */
export async function readCsatSettings(db: ReadExecutor): Promise<CsatSettings> {
  const [enabled, reminder, cooldown] = await Promise.all([
    readSettingValue(db, CSAT_ENABLED_SETTING_KEY),
    readSettingValue(db, CSAT_REMINDER_SETTING_KEY),
    readSettingValue(db, CSAT_COOLDOWN_SETTING_KEY),
  ]);
  return {
    enabled: typeof enabled === 'boolean' ? enabled : true,
    delayMinutes: await readCsatDelayMinutes(db),
    reminderHours: wholeBetween(reminder, CSAT_REMINDER_MAX_HOURS)
      ? reminder
      : CSAT_REMINDER_AFTER_HOURS,
    cooldownDays: wholeBetween(cooldown, CSAT_COOLDOWN_MAX_DAYS)
      ? cooldown
      : CSAT_CONTACT_COOLDOWN_DAYS,
  };
}

/**
 * Changes the settings named in `patch` (T-174); the rest stay. Applies to surveys scheduled or sent
 * after the change. One audit entry with the old and new values of what changed.
 */
export async function updateCsatSettings(
  tx: DbTransaction,
  ctx: DomainContext,
  patch: CsatSettingsUpdate,
): Promise<DomainResult<CsatSettings>> {
  const fx = new Effects();
  const before = await readCsatSettings(tx);
  const next: CsatSettings = {
    enabled: patch.enabled ?? before.enabled,
    delayMinutes: patch.delayMinutes ?? before.delayMinutes,
    reminderHours: patch.reminderHours ?? before.reminderHours,
    cooldownDays: patch.cooldownDays ?? before.cooldownDays,
  };
  const keys: Readonly<Record<keyof CsatSettings, string>> = {
    enabled: CSAT_ENABLED_SETTING_KEY,
    delayMinutes: CSAT_DELAY_SETTING_KEY,
    reminderHours: CSAT_REMINDER_SETTING_KEY,
    cooldownDays: CSAT_COOLDOWN_SETTING_KEY,
  };
  const was: Record<string, unknown> = {};
  const now: Record<string, unknown> = {};
  for (const name of Object.keys(keys) as (keyof CsatSettings)[]) {
    if (next[name] === before[name]) continue;
    const value = next[name];
    // The rows come with migration 0084 (the application role may update them, not insert).
    const updated = await tx
      .update(schema.instanceSetting)
      .set({ value, updatedBy: ctx.actor.id, updatedAt: ctx.now() })
      .where(eq(schema.instanceSetting.key, keys[name]))
      .returning({ key: schema.instanceSetting.key });
    if (updated.length === 0) throw new Error(`instance_setting row ${keys[name]} is missing`);
    was[name] = before[name];
    now[name] = value;
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.csatSettingSet,
    targetType: 'instance_setting',
    targetId: null,
    before: was,
    after: now,
  });
  return fx.result(next);
}

/** Opts an organization out of (or back into) surveys (R-10.4); audited. */
export async function setCsatOptOut(
  tx: DbTransaction,
  ctx: DomainContext,
  orgId: string,
  optedOut: boolean,
): Promise<DomainResult<{ orgId: string; optedOut: boolean }>> {
  const fx = new Effects();
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .limit(1);
  if (!org) throw notFound('No such organization');
  const [existing] = await tx
    .select({ orgId: schema.csatOrgOptOut.orgId })
    .from(schema.csatOrgOptOut)
    .where(eq(schema.csatOrgOptOut.orgId, orgId))
    .limit(1);
  if (optedOut && !existing) {
    await tx.insert(schema.csatOrgOptOut).values({ orgId, createdBy: ctx.actor.id });
  } else if (!optedOut && existing) {
    await tx.delete(schema.csatOrgOptOut).where(eq(schema.csatOrgOptOut.orgId, orgId));
  }
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.csatOptOutSet,
    targetType: 'organization',
    targetId: orgId,
    before: { optedOut: existing !== undefined },
    after: { optedOut },
  });
  return fx.result({ orgId, optedOut });
}

async function isOptedOut(db: ReadExecutor, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ orgId: schema.csatOrgOptOut.orgId })
    .from(schema.csatOrgOptOut)
    .where(eq(schema.csatOrgOptOut.orgId, orgId))
    .limit(1);
  return row !== undefined;
}

/** True when another survey reached this contact in the last 7 days (R-10.4: at most one per contact per 7 days). */
async function surveyedRecently(
  db: ReadExecutor,
  contactId: string,
  now: Date,
  exceptSurveyId: string | null,
  cooldownDays: number,
): Promise<boolean> {
  if (cooldownDays === 0) return false;
  const since = new Date(now.getTime() - cooldownDays * DAY_MS);
  const [row] = await db
    .select({ id: schema.csatSurvey.id })
    .from(schema.csatSurvey)
    .where(
      and(
        eq(schema.csatSurvey.contactId, contactId),
        gt(schema.csatSurvey.sentAt, since),
        inArray(schema.csatSurvey.status, ['sent', 'answered', 'expired']),
        ...(exceptSurveyId === null ? [] : [ne(schema.csatSurvey.id, exceptSurveyId)]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

function localeOf(contact: ContactRow, ticket: TicketRow): PortalLocale {
  const prefs: unknown = contact.notificationPrefs;
  const fromContact = portalLocaleSchema.safeParse(
    typeof prefs === 'object' && prefs !== null && 'locale' in prefs ? prefs.locale : undefined,
  );
  if (fromContact.success) return fromContact.data;
  const custom: unknown = ticket.customFields;
  const portal =
    typeof custom === 'object' && custom !== null && 'portal' in custom ? custom.portal : undefined;
  const fromTicket = portalLocaleSchema.safeParse(
    typeof portal === 'object' && portal !== null && 'locale' in portal ? portal.locale : undefined,
  );
  return fromTicket.success ? fromTicket.data : DEFAULT_PORTAL_LOCALE;
}

/**
 * A ticket was resolved: owe its requester a survey after the configured delay (R-10.1), unless a
 * rule spares them (R-10.4): not for internal or machine tickets (no row), not when the organization
 * opted out, not when the contact was surveyed in the last 7 days, not without an email address
 * (the last three leave a `skipped` row that says why). Called by `applyStatus` inside its
 * transaction, so the survey exists if and only if the status change committed.
 */
export async function scheduleSurvey(
  tx: DbTransaction,
  ctx: DomainContext,
  ticket: TicketRow,
): Promise<void> {
  if (!EMAIL_SURVEY_CHANNELS.includes(ticket.channel) || ticket.requesterContactId === null) return;
  const settings = await readCsatSettings(tx);
  // Switched off by an admin (T-174): no survey is owed, and no row says so for every ticket.
  if (!settings.enabled) return;
  const [contact] = await tx
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, ticket.requesterContactId))
    .limit(1);
  if (!contact) return;
  const now = ctx.now();
  const skip = async (reason: CsatReason): Promise<void> => {
    await tx
      .insert(schema.csatSurvey)
      .values({
        ticketId: ticket.id,
        contactId: contact.id,
        orgId: ticket.orgId,
        status: 'skipped',
        reason,
        sendAfter: now,
      })
      .onConflictDoNothing();
  };
  if (contact.emails[0] === undefined) return skip('no_contact_email');
  if (await isOptedOut(tx, ticket.orgId)) return skip('org_opt_out');
  if (await surveyedRecently(tx, contact.id, now, null, settings.cooldownDays)) {
    return skip('contact_cooldown');
  }
  const delayMinutes = settings.delayMinutes;
  await tx
    .insert(schema.csatSurvey)
    .values({
      ticketId: ticket.id,
      contactId: contact.id,
      orgId: ticket.orgId,
      status: 'scheduled',
      sendAfter: new Date(now.getTime() + delayMinutes * 60_000),
    })
    .onConflictDoNothing();
}

/**
 * A ticket was reopened: a survey that is still owed or still waiting for an answer is void (R-10.4:
 * "stop and void if reopened"), and its link stops working. An answered survey stays as it is.
 */
export async function voidOpenSurveys(
  tx: DbTransaction,
  ctx: DomainContext,
  fx: Effects,
  ticketId: string,
): Promise<void> {
  const voided = await tx
    .update(schema.csatSurvey)
    .set({ status: 'voided', reason: 'ticket_reopened', updatedAt: ctx.now() })
    .where(
      and(
        eq(schema.csatSurvey.ticketId, ticketId),
        inArray(schema.csatSurvey.status, ['scheduled', 'sent']),
      ),
    )
    .returning({ id: schema.csatSurvey.id });
  for (const row of voided) {
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.csatSurveyVoided,
      targetType: 'csat_survey',
      targetId: row.id,
      metadata: { ticketId, reason: 'ticket_reopened' },
    });
  }
}

export interface SweepSurveysResult {
  readonly sent: number;
  readonly reminded: number;
  readonly skipped: number;
  readonly voided: number;
  readonly expired: number;
}

export interface SweepSurveysOptions {
  /** The most surveys sent, and the most reminders sent, in one sweep. Default 50. */
  readonly limit?: number;
}

type SendOutcome = 'sent' | 'skipped' | 'voided' | 'gone';

/** Queues the survey email in the outbox, in the caller's transaction. */
async function queueEmail(
  tx: Executor,
  ctx: DomainContext,
  survey: typeof schema.csatSurvey.$inferSelect,
  ticket: TicketRow,
  contact: ContactRow,
  tokenExpiresAt: Date,
  reminder: boolean,
): Promise<void> {
  const { signingKey, landingUrl } = csatConfig(ctx);
  const to = contact.emails[0];
  if (to === undefined) throw new Error('survey contact has no email');
  const { clear, secret } = splitEmailSecrets({
    kind: 'csat_survey',
    to,
    locale: localeOf(contact, ticket),
    ticketKey: ticketKeysOf(ctx).format(ticket.number),
    surveyUrl: csatSurveyUrl(landingUrl, mintCsatToken(signingKey, survey.id, tokenExpiresAt)),
    reminder,
    // A ticket that came in through a Gmail mailbox is answered from that mailbox, not from SMTP.
    ...(ticket.channel === 'gmail' && ticket.channelAccountId !== null
      ? { gmail: { accountId: ticket.channelAccountId, surveyId: survey.id } }
      : {}),
  });
  await enqueueJob(tx, ctx.config, {
    queue: QUEUE_NAMES.email,
    name: EMAIL_JOBS.send,
    jobId: `${reminder ? 'csat-reminder' : 'csat-survey'}-${survey.id}`,
    payload: clear,
    secret,
    expiresAt: new Date(ctx.now().getTime() + PORTAL_EMAIL_TTL_SECONDS * 1000),
    options: EMAIL_OUTBOX_JOB_OPTIONS,
  });
}

async function loadSubject(
  tx: Executor,
  survey: typeof schema.csatSurvey.$inferSelect,
): Promise<{ ticket: TicketRow; contact: ContactRow } | null> {
  const [ticket] = await tx
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, survey.ticketId))
    .limit(1);
  const [contact] = await tx
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, survey.contactId))
    .limit(1);
  return ticket && contact ? { ticket, contact } : null;
}

async function sendOne(tx: Executor, ctx: DomainContext, id: string): Promise<SendOutcome> {
  const fx = new Effects();
  const [survey] = await tx
    .select()
    .from(schema.csatSurvey)
    .where(and(eq(schema.csatSurvey.id, id), eq(schema.csatSurvey.status, 'scheduled')))
    .for('update', { skipLocked: true });
  if (!survey) return 'gone';
  const now = ctx.now();
  const subject = await loadSubject(tx, survey);
  if (!subject) return 'gone';
  const { ticket, contact } = subject;
  const finish = async (status: 'voided' | 'skipped', reason: CsatReason): Promise<SendOutcome> => {
    await tx
      .update(schema.csatSurvey)
      .set({ status, reason, updatedAt: now })
      .where(eq(schema.csatSurvey.id, survey.id));
    if (status === 'voided') {
      await recordAuditInTx(tx, ctx, fx, {
        action: AUDIT_ACTIONS.csatSurveyVoided,
        targetType: 'csat_survey',
        targetId: survey.id,
        metadata: { ticketId: ticket.id, reason },
      });
    }
    return status;
  };
  // R-10.1: not if the ticket was reopened before the survey went out. A closed ticket is still finished.
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return finish('voided', 'ticket_reopened');
  }
  const settings = await readCsatSettings(tx);
  if (!settings.enabled) return finish('skipped', 'csat_disabled');
  if (contact.emails[0] === undefined) return finish('skipped', 'no_contact_email');
  if (await isOptedOut(tx, ticket.orgId)) return finish('skipped', 'org_opt_out');
  if (await surveyedRecently(tx, contact.id, now, survey.id, settings.cooldownDays)) {
    return finish('skipped', 'contact_cooldown');
  }
  const tokenExpiresAt = wholeSeconds(new Date(now.getTime() + CSAT_LINK_TTL_DAYS * DAY_MS));
  await queueEmail(tx, ctx, survey, ticket, contact, tokenExpiresAt, false);
  await tx
    .update(schema.csatSurvey)
    .set({
      status: 'sent',
      sentAt: now,
      tokenExpiresAt,
      // 0 hours = no reminder: the column stays empty, so the sweep never finds it.
      reminderDueAt:
        settings.reminderHours === 0
          ? null
          : new Date(now.getTime() + settings.reminderHours * HOUR_MS),
      updatedAt: now,
    })
    .where(eq(schema.csatSurvey.id, survey.id));
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.csatSurveySent,
    targetType: 'csat_survey',
    targetId: survey.id,
    metadata: { ticketId: ticket.id, channel: survey.channel },
  });
  return 'sent';
}

async function remindOne(
  tx: Executor,
  ctx: DomainContext,
  id: string,
): Promise<'reminded' | 'voided' | 'gone'> {
  const fx = new Effects();
  const now = ctx.now();
  const [survey] = await tx
    .select()
    .from(schema.csatSurvey)
    .where(
      and(
        eq(schema.csatSurvey.id, id),
        eq(schema.csatSurvey.status, 'sent'),
        sql`${schema.csatSurvey.reminderSentAt} IS NULL`,
        gt(schema.csatSurvey.tokenExpiresAt, now),
      ),
    )
    .for('update', { skipLocked: true });
  if (!survey?.tokenExpiresAt) return 'gone';
  const subject = await loadSubject(tx, survey);
  if (!subject) return 'gone';
  const { ticket, contact } = subject;
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    await tx
      .update(schema.csatSurvey)
      .set({ status: 'voided', reason: 'ticket_reopened', updatedAt: now })
      .where(eq(schema.csatSurvey.id, survey.id));
    await recordAuditInTx(tx, ctx, fx, {
      action: AUDIT_ACTIONS.csatSurveyVoided,
      targetType: 'csat_survey',
      targetId: survey.id,
      metadata: { ticketId: ticket.id, reason: 'ticket_reopened' },
    });
    return 'voided';
  }
  if (contact.emails[0] === undefined) return 'gone';
  await queueEmail(tx, ctx, survey, ticket, contact, survey.tokenExpiresAt, true);
  await tx
    .update(schema.csatSurvey)
    .set({ reminderSentAt: now, updatedAt: now })
    .where(eq(schema.csatSurvey.id, survey.id));
  await recordAuditInTx(tx, ctx, fx, {
    action: AUDIT_ACTIONS.csatSurveyReminded,
    targetType: 'csat_survey',
    targetId: survey.id,
    metadata: { ticketId: ticket.id },
  });
  return 'reminded';
}

/**
 * The scheduler (R-10.1, R-10.4): sends the surveys that are due, sends the one reminder that is
 * due, and closes links that ran out. Every survey is handled in its own transaction with the email
 * written to the outbox in it (ADR-006), so a crash sends it once or not at all, and two sweeps
 * running together never take the same row (`FOR UPDATE SKIP LOCKED`).
 */
export async function sweepSurveys(
  db: Database['db'],
  ctx: DomainContext,
  options: SweepSurveysOptions = {},
): Promise<SweepSurveysResult> {
  const limit = options.limit ?? 50;
  const now = ctx.now();
  let sent = 0;
  let skipped = 0;
  let voided = 0;
  let reminded = 0;

  const due = await db
    .select({ id: schema.csatSurvey.id })
    .from(schema.csatSurvey)
    .where(and(eq(schema.csatSurvey.status, 'scheduled'), lte(schema.csatSurvey.sendAfter, now)))
    .orderBy(asc(schema.csatSurvey.sendAfter))
    .limit(limit);
  for (const { id } of due) {
    const outcome = await db.transaction((tx) => sendOne(tx, ctx, id));
    if (outcome === 'sent') sent += 1;
    else if (outcome === 'skipped') skipped += 1;
    else if (outcome === 'voided') voided += 1;
  }

  // While surveys are switched off nothing more goes to a customer, a reminder included.
  const remindersEnabled = (await readCsatSettings(db)).enabled;
  const remindersDue = remindersEnabled
    ? await db
        .select({ id: schema.csatSurvey.id })
        .from(schema.csatSurvey)
        .where(
          and(
            eq(schema.csatSurvey.status, 'sent'),
            sql`${schema.csatSurvey.reminderSentAt} IS NULL`,
            lte(schema.csatSurvey.reminderDueAt, now),
            gt(schema.csatSurvey.tokenExpiresAt, now),
          ),
        )
        .orderBy(asc(schema.csatSurvey.reminderDueAt))
        .limit(limit)
    : [];
  for (const { id } of remindersDue) {
    const outcome = await db.transaction((tx) => remindOne(tx, ctx, id));
    if (outcome === 'reminded') reminded += 1;
    else if (outcome === 'voided') voided += 1;
  }

  const expired = await db
    .update(schema.csatSurvey)
    .set({ status: 'expired', updatedAt: now })
    .where(and(eq(schema.csatSurvey.status, 'sent'), lte(schema.csatSurvey.tokenExpiresAt, now)))
    .returning({ id: schema.csatSurvey.id });

  return { sent, reminded, skipped, voided, expired: expired.length };
}

/** What the landing page needs to know about a survey link. */
export type SurveyLookup =
  | {
      readonly state: 'open';
      readonly surveyId: string;
      readonly ticketKey: string;
      readonly locale: PortalLocale;
      readonly expiresAt: Date;
    }
  /** A link is single-use: this survey already has its answer. */
  | { readonly state: 'answered' };

/**
 * The survey behind a verified link. `open`: sent, link not expired. `answered`: the single use is
 * spent. Anything else (unknown, voided, expired, never sent) is null; the caller answers all of
 * those alike so a link says nothing about which surveys exist.
 */
export async function findSurveyForLink(
  db: ReadExecutor,
  ctx: DomainContext,
  surveyId: string,
): Promise<SurveyLookup | null> {
  const [row] = await db
    .select({
      survey: schema.csatSurvey,
      ticket: schema.ticket,
      contact: schema.contact,
    })
    .from(schema.csatSurvey)
    .innerJoin(schema.ticket, eq(schema.ticket.id, schema.csatSurvey.ticketId))
    .innerJoin(schema.contact, eq(schema.contact.id, schema.csatSurvey.contactId))
    .where(eq(schema.csatSurvey.id, surveyId))
    .limit(1);
  if (!row) return null;
  if (row.survey.status === 'answered') return { state: 'answered' };
  const expiresAt = row.survey.tokenExpiresAt;
  if (row.survey.status !== 'sent' || expiresAt === null || expiresAt <= ctx.now()) return null;
  return {
    state: 'open',
    surveyId: row.survey.id,
    ticketKey: ticketKeysOf(ctx).format(row.ticket.number),
    locale: localeOf(row.contact, row.ticket),
    expiresAt,
  };
}

export interface AnswerSurveyInput {
  readonly surveyId: string;
  readonly score: number;
  readonly resolved?: boolean | undefined;
  readonly comment?: string | undefined;
}

export type AnswerSurveyOutcome =
  | { readonly kind: 'recorded'; readonly reopened: boolean; readonly ticketId: string }
  /** A link is single-use: this survey already has its answer. */
  | { readonly kind: 'already_answered' }
  /** Unknown, expired, voided or not sent: the caller must not say which. */
  | { readonly kind: 'unavailable' };

/**
 * Records the customer's answer (R-10.2, R-10.5). The first answer wins: the survey row moves from
 * `sent` to `answered` in one conditional UPDATE, so a second request with the same link (a double
 * click, a replay) changes nothing. The score is copied to the ticket and an internal event is
 * written (score only, never the comment). A score below 3, or "not resolved", reopens a ticket that
 * is still `resolved` inside the 7-day window (R-1.10) through the normal status machinery, so the
 * reopen count, the SLA clock and the audit trail are the same as any other reopen.
 */
export async function answerSurvey(
  tx: DbTransaction,
  ctx: DomainContext,
  input: AnswerSurveyInput,
): Promise<DomainResult<AnswerSurveyOutcome>> {
  const fx = new Effects();
  const now = ctx.now();
  const comment = input.comment === undefined || input.comment === '' ? null : input.comment;
  const [survey] = await tx
    .update(schema.csatSurvey)
    .set({
      status: 'answered',
      answeredAt: now,
      score: input.score,
      resolved: input.resolved ?? null,
      comment,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.csatSurvey.id, input.surveyId),
        eq(schema.csatSurvey.status, 'sent'),
        gt(schema.csatSurvey.tokenExpiresAt, now),
      ),
    )
    .returning();
  if (!survey) {
    const [existing] = await tx
      .select({ status: schema.csatSurvey.status })
      .from(schema.csatSurvey)
      .where(eq(schema.csatSurvey.id, input.surveyId))
      .limit(1);
    return fx.result(
      existing?.status === 'answered' ? { kind: 'already_answered' } : { kind: 'unavailable' },
    );
  }

  // From here on the customer is the actor, whoever the caller said (the public endpoint has no user).
  const actx: DomainContext = { ...ctx, actor: { type: 'anonymous', id: survey.contactId } };
  const [locked] = await tx
    .select()
    .from(schema.ticket)
    .where(eq(schema.ticket.id, survey.ticketId))
    .for('update');
  if (!locked) throw conflict('The survey ticket is gone');
  let ticket = locked;
  const decision = decideCsatReopen({
    score: input.score,
    resolved: input.resolved,
    ticketStatus: ticket.status,
    resolvedAt: ticket.resolvedAt,
    now,
    windowDays: ctx.config.reopenWindowDays,
  });

  const [scored] = await tx
    .update(schema.ticket)
    .set({ csatScore: input.score, updatedAt: now })
    .where(eq(schema.ticket.id, ticket.id))
    .returning();
  ticket = scored ?? ticket;
  await recordTicketEvent(tx, ticket.id, TICKET_EVENT_TYPES.csatReceived, actx.actor, 'internal', {
    surveyId: survey.id,
    score: input.score,
    ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
    reopened: decision.reopen,
  });
  fx.emit(ticketEvent(actx, 'ticket.updated', ticket, ['csat']));

  if (decision.reopen) {
    // Automatic: the customer caused it, so they are not told "in progress" by email.
    ticket = await applyStatus(tx, actx, fx, ticket, 'open', {
      reason: decision.reason === 'low_score' ? 'csat_low_score' : 'csat_not_resolved',
      automatic: true,
    });
    await tx
      .update(schema.csatSurvey)
      .set({ reopened: true })
      .where(eq(schema.csatSurvey.id, survey.id));
  }
  await recordAuditInTx(tx, actx, fx, {
    action: AUDIT_ACTIONS.csatResponse,
    targetType: 'csat_survey',
    targetId: survey.id,
    metadata: {
      ticketId: ticket.id,
      score: input.score,
      ...(input.resolved === undefined ? {} : { resolved: input.resolved }),
      reopened: decision.reopen,
      ...(decision.reopen ? {} : { reopenSkipped: decision.reason }),
    },
  });
  return fx.result({ kind: 'recorded', reopened: decision.reopen, ticketId: ticket.id });
}
