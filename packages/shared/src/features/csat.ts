/**
 * CSAT and reopen rules (T-110): this feature's own audit actions, ticket event types and queue names (T-123a),
 * and the contracts of its endpoints (R-10.1 to R-10.5, R-1.10).
 *
 * The task that owns this feature adds entries here and nowhere else in `packages/shared`. The
 * global `AUDIT_ACTIONS`, `TICKET_EVENT_TYPES` and `QUEUE_NAMES` are composed from these records
 * (see `./index.ts`), and importing `@watchtower/shared` throws if two features use the same key
 * or the same value. Keys are camelCase; values are lowercase strings (dotted for audit actions and
 * ticket events, the BullMQ queue name for queues). Start a value with the feature name so
 * collisions are unlikely.
 */
import { z } from 'zod';

import { cursorSchema, pageLimit, pageOf } from '../common.js';

/** Audit `action` strings written by this feature. */
export const CSAT_AUDIT_ACTIONS = {
  csatSurveySent: 'csat.survey_sent',
  csatSurveyReminded: 'csat.survey_reminded',
  csatSurveyVoided: 'csat.survey_voided',
  csatResponse: 'csat.response',
  csatAccessDenied: 'csat.access_denied',
  csatRateLimited: 'csat.rate_limited',
  csatSettingSet: 'csat.setting_set',
  csatOptOutSet: 'csat.opt_out_set',
  csatResultsRead: 'csat.results_read',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const CSAT_TICKET_EVENTS = {
  /** The customer answered the survey (internal; carries the score, never the comment). */
  csatReceived: 'ticket.csat_received',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, consumer: worker). */
export const CSAT_QUEUES = {
  csat: 'csat',
} as const satisfies Record<string, string>;

export const CSAT_JOBS = {
  /** Sends due surveys, due reminders, and closes links that ran out. */
  sweep: 'sweep',
} as const;

/** The survey link is `<APP_URL>/csat#token=<token>&score=<1-5>`: both stay in the fragment (never in a log). */
export const CSAT_LANDING_PATH = '/csat';
export const CSAT_TOKEN_FRAGMENT_KEY = 'token';
export const CSAT_SCORE_FRAGMENT_KEY = 'score';
/**
 * The shape of a survey link token (`wtc1.<32 hex>.<base 36 expiry>.<43 base64url>`, see
 * `packages/domain/src/csat/token.ts`). Fixed lengths, so a scan for it cannot backtrack. A customer
 * who quotes the survey link in a reply sends a bearer token back to us (T-171 review C-8): it is
 * taken out of inbound text before the text is stored or sent to a model.
 */
export const CSAT_LINK_TOKEN_SOURCE = 'wtc1\.[0-9a-f]{32}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{43}';
export const CSAT_LINK_REMOVED = '[survey-link-removed]';

/** `text` with every survey link token replaced by `CSAT_LINK_REMOVED`. */
export function stripCsatLinkTokens(text: string): string {
  if (!text.includes('wtc1.')) return text;
  return text.replace(new RegExp(CSAT_LINK_TOKEN_SOURCE, 'g'), CSAT_LINK_REMOVED);
}

/** The page sends the token in this header; never in a URL, a query string or a cookie. */
export const CSAT_TOKEN_HEADER = 'x-csat-token';

/** Instance setting: minutes between "resolved" and the survey (R-10.1). */
export const CSAT_DELAY_SETTING_KEY = 'csat.delay_minutes';
/** `[ASSUMED]` R-10.1 says one hour by default. */
export const CSAT_DELAY_DEFAULT_MINUTES = 60;
export const CSAT_DELAY_MAX_MINUTES = 10_080;
/** Instance setting: surveys on or off for the whole instance (T-174). Default on. */
export const CSAT_ENABLED_SETTING_KEY = 'csat.enabled';
/** Instance setting: hours between the survey and its one reminder; 0 sends no reminder (T-174). */
export const CSAT_REMINDER_SETTING_KEY = 'csat.reminder_hours';
/** Instance setting: days during which a contact is not surveyed again; 0 turns the rule off (T-174). */
export const CSAT_COOLDOWN_SETTING_KEY = 'csat.cooldown_days';
/** One reminder, this long after the survey went out, if unanswered (R-10.4). The default. */
export const CSAT_REMINDER_AFTER_HOURS = 48;
export const CSAT_REMINDER_MAX_HOURS = 720;
/** At most one survey per contact in this many days (R-10.4). The default. */
export const CSAT_CONTACT_COOLDOWN_DAYS = 7;
export const CSAT_COOLDOWN_MAX_DAYS = 90;
/** `[ASSUMED]` how long a survey link works. The PRD does not say; the reminder is at 48 h, the reopen window is 7 days. */
export const CSAT_LINK_TTL_DAYS = 14;
/** A score below this reopens the ticket (R-1.10: "CSAT < 3"; R-10.5: "score <= 2"). */
export const CSAT_REOPEN_BELOW_SCORE = 3;
export const CSAT_COMMENT_MAX_LENGTH = 2000;

export const CSAT_SURVEY_STATUSES = [
  'scheduled',
  'sent',
  'answered',
  'voided',
  'skipped',
  'expired',
] as const;
export const csatSurveyStatusSchema = z.enum(CSAT_SURVEY_STATUSES);
export type CsatSurveyStatus = z.infer<typeof csatSurveyStatusSchema>;

/** Why a survey was skipped or voided. Stable codes, never free text. */
export const CSAT_REASONS = [
  'org_opt_out',
  'contact_cooldown',
  'ticket_reopened',
  'not_resolved',
  'no_contact_email',
  'csat_disabled',
] as const;
export type CsatReason = (typeof CSAT_REASONS)[number];

const scoreSchema = z.number().int().min(1).max(5);

/** What the landing page shows before the customer answers. */
export const csatSurveyViewSchema = z.object({
  ticketKey: z.string(),
  /** The language of the email that carried the link (the page uses its own i18n). */
  locale: z.enum(['en', 'th']),
  expiresAt: z.iso.datetime(),
});
export type CsatSurveyView = z.infer<typeof csatSurveyViewSchema>;

export const csatResponseInputSchema = z.strictObject({
  score: scoreSchema,
  /** "Was this resolved?" (R-10.2). Omitted when the customer did not say. */
  resolved: z.boolean().optional(),
  comment: z.string().trim().max(CSAT_COMMENT_MAX_LENGTH).optional(),
});
export type CsatResponseInput = z.infer<typeof csatResponseInputSchema>;

/** What the customer is told after answering. It does not say whether the ticket was reopened. */
export const csatResponseResultSchema = z.object({ recorded: z.literal(true) });
export type CsatResponseResult = z.infer<typeof csatResponseResultSchema>;

export const csatResponsesQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  /** Only answers at or below this score (the unhappy ones). */
  maxScore: z.coerce.number().int().min(1).max(5).optional(),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type CsatResponsesQuery = z.infer<typeof csatResponsesQuerySchema>;

export const csatResponseItemSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  ticketKey: z.string(),
  score: scoreSchema,
  resolved: z.boolean().nullable(),
  comment: z.string().nullable(),
  reopened: z.boolean(),
  aiHandled: z.boolean(),
  assigneeId: z.uuid().nullable(),
  intentId: z.uuid().nullable(),
  answeredAt: z.iso.datetime(),
});
export type CsatResponseItem = z.infer<typeof csatResponseItemSchema>;
export const csatResponsesPageSchema = pageOf(csatResponseItemSchema);
export type CsatResponsesPage = z.infer<typeof csatResponsesPageSchema>;

export const csatSummaryQuerySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type CsatSummaryQuery = z.infer<typeof csatSummaryQuerySchema>;

const bucketSchema = z.object({ count: z.number().int(), average: z.number().nullable() });

/** CSAT metrics for a period (R-10.5): overall, per agent, per intent, AI-handled against human. */
export const csatSummarySchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  surveysSent: z.number().int(),
  responses: z.number().int(),
  /** responses / surveysSent, null when none were sent. */
  responseRate: z.number().nullable(),
  average: z.number().nullable(),
  reopened: z.number().int(),
  distribution: z.object({
    '1': z.number().int(),
    '2': z.number().int(),
    '3': z.number().int(),
    '4': z.number().int(),
    '5': z.number().int(),
  }),
  aiHandled: bucketSchema,
  human: bucketSchema,
  byAgent: z.array(
    bucketSchema.extend({ assigneeId: z.uuid().nullable(), name: z.string().nullable() }),
  ),
  byIntent: z.array(
    bucketSchema.extend({ intentId: z.uuid().nullable(), name: z.string().nullable() }),
  ),
});
export type CsatSummary = z.infer<typeof csatSummarySchema>;

const csatSettingFields = {
  /** Surveys on or off for the instance. Default on. */
  enabled: z.boolean(),
  /** Minutes between "resolved" and the survey; 0 sends at the next sweep. Default 60. */
  delayMinutes: z.number().int().min(0).max(CSAT_DELAY_MAX_MINUTES),
  /** Hours from the survey to its one reminder; 0 = no reminder. Default 48. */
  reminderHours: z.number().int().min(0).max(CSAT_REMINDER_MAX_HOURS),
  /** A contact is surveyed at most once in this many days; 0 = no limit. Default 7. */
  cooldownDays: z.number().int().min(0).max(CSAT_COOLDOWN_MAX_DAYS),
};

/** What `GET /v1/csat/settings` returns: every setting. */
export const csatSettingsSchema = z.strictObject(csatSettingFields);
export type CsatSettings = z.infer<typeof csatSettingsSchema>;

/** `PUT /v1/csat/settings`: send the ones to change (an older client sending only `delayMinutes` still works). */
export const csatSettingsUpdateSchema = z
  .strictObject({
    enabled: csatSettingFields.enabled.optional(),
    delayMinutes: csatSettingFields.delayMinutes.optional(),
    reminderHours: csatSettingFields.reminderHours.optional(),
    cooldownDays: csatSettingFields.cooldownDays.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Send at least one setting',
  });
export type CsatSettingsUpdate = z.infer<typeof csatSettingsUpdateSchema>;

export const csatOptOutParamSchema = z.object({ orgId: z.uuid() });
export const csatOptOutSchema = z.strictObject({ optedOut: z.boolean() });
export type CsatOptOut = z.infer<typeof csatOptOutSchema>;
export const csatOptOutResultSchema = z.object({ orgId: z.uuid(), optedOut: z.boolean() });
export type CsatOptOutResult = z.infer<typeof csatOptOutResultSchema>;

/** The survey page link for an email: the token and an optional preselected score, both in the fragment. */
export function csatSurveyUrl(landingUrl: string, token: string, score?: number): string {
  const url = new URL(landingUrl);
  const parts = [`${CSAT_TOKEN_FRAGMENT_KEY}=${token}`];
  if (score !== undefined) parts.push(`${CSAT_SCORE_FRAGMENT_KEY}=${String(score)}`);
  url.hash = parts.join('&');
  return url.toString();
}
