/**
 * Incidents, the deploy feed, Discord threads and mass communication (T-202): this feature's own
 * audit actions, ticket event types and queue names (T-200), and the HTTP schemas of `/v1/incidents`
 * and the deploy feed.
 *
 * Browser-safe (no Node imports). Free text appears in exactly three places, all staff-written and
 * internal: an incident's title, its root cause and a timeline note. Nothing here is ever sent to
 * Discord (N4): chat gets the incident number, the severity and status enumerations and service slugs.
 */
import { z } from 'zod';

import { attachmentIdsSchema } from '../uploads.js';

/** Audit `action` strings written by this feature. Metadata holds ids and enumerations. */
export const INCIDENTS_AUDIT_ACTIONS = {
  incidentCreate: 'incident.create',
  incidentUpdate: 'incident.update',
  incidentResolve: 'incident.resolve',
  incidentLinkTicket: 'incident.link_ticket',
  incidentUnlinkTicket: 'incident.unlink_ticket',
  incidentLinkAlert: 'incident.link_alert',
  incidentNote: 'incident.note',
  /** A deploy event arrived on the feed (system actor). */
  deployRecord: 'deploy.record',
  /** An update for the customers of an incident was drafted (by a person or the AI). */
  incidentCommDraft: 'incident.comm.draft',
  /** A person pressed Send: the update went to the linked tickets, one by one. */
  incidentCommSend: 'incident.comm.send',
} as const satisfies Record<string, string>;

/** `ticket_event.type` strings written by this feature. */
export const INCIDENTS_TICKET_EVENTS = {
  incidentLinked: 'incident.linked',
  incidentUnlinked: 'incident.unlinked',
} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api, worker; consumer: worker). */
export const INCIDENTS_QUEUES = {
  incidents: 'incidents',
} as const satisfies Record<string, string>;

export const INCIDENTS_JOBS = {
  /** Creates the Discord thread of an incident. `jobId` is per incident. */
  thread: 'thread',
  /** Mirrors one key timeline entry into the thread. `jobId` is per incident and entry. */
  mirror: 'mirror',
} as const;

/** A chat post is retried with backoff; a thread that does not exist yet makes a mirror job wait its turn. */
export const INCIDENTS_OUTBOX_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** `incidents.thread` / `incidents.mirror` payload: ids only; the worker loads what it posts (N4). */
export const incidentThreadJobSchema = z.object({ incidentId: z.uuid() });
export const incidentMirrorJobSchema = z.object({
  incidentId: z.uuid(),
  timelineId: z.uuid(),
});
export type IncidentThreadJob = z.infer<typeof incidentThreadJobSchema>;
export type IncidentMirrorJob = z.infer<typeof incidentMirrorJobSchema>;

// --- vocabulary ----------------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);

export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);

/**
 * A status may move between the three open ones in either direction (a fix that did not hold goes
 * back to `investigating`) and to `resolved` from any of them. `resolved` is final: a new problem is a
 * new incident. Resolving is a separate permission (`incident.manage`); the incident never resolves by
 * itself when its alerts close (PRD section 5.3).
 */
export function incidentStatusAllows(from: IncidentStatus, to: IncidentStatus): boolean {
  if (from === 'resolved') return false;
  return from !== to;
}

export const INCIDENT_TIMELINE_TYPES = [
  'created',
  'status_changed',
  'severity_changed',
  'commander_changed',
  'alert_linked',
  'ticket_linked',
  'ticket_unlinked',
  'service_added',
  'note',
  'comms_drafted',
  'comms_sent',
  'thread_created',
  'deploy_noted',
] as const;
export type IncidentTimelineType = (typeof INCIDENT_TIMELINE_TYPES)[number];

/**
 * Timeline types that are mirrored into the Discord thread ("key timeline entries", R-3.13). A note's
 * text and a ticket's subject are never mirrored; the line says what kind of thing happened.
 */
export const MIRRORED_TIMELINE_TYPES = [
  'created',
  'status_changed',
  'severity_changed',
  'commander_changed',
  'comms_sent',
] as const satisfies readonly IncidentTimelineType[];

export const INCIDENT_KEY_PREFIX = 'INC';
export function formatIncidentKey(number: number): string {
  return `${INCIDENT_KEY_PREFIX}-${String(number)}`;
}
/** `INC-12` (any case) to 12, else null. */
export function parseIncidentKey(text: string): number | null {
  const match = /^INC-([0-9]{1,9})$/i.exec(text.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

// --- incidents (R-3.12) --------------------------------------------------------------------------

export const createIncidentSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  severity: incidentSeveritySchema,
  /** The affected services (catalog ids). */
  serviceIds: z.array(z.uuid()).max(20).default([]),
  /** Alerts to attach (an incident proposed from a correlation group passes its alerts). */
  alertIds: z.array(z.uuid()).max(100).default([]),
  /** Tickets to link; their organizations become affected organizations. */
  ticketIds: z.array(z.uuid()).max(500).default([]),
  /** Organizations affected, added by hand. */
  orgIds: z.array(z.uuid()).max(100).default([]),
  commanderId: z.uuid().nullable().optional(),
});
export type CreateIncident = z.infer<typeof createIncidentSchema>;

export const updateIncidentSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    severity: incidentSeveritySchema,
    status: incidentStatusSchema,
    commanderId: z.uuid().nullable(),
    rootCause: z.string().trim().max(4000).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
export type UpdateIncident = z.infer<typeof updateIncidentSchema>;

export const linkTicketSchema = z.strictObject({ ticketId: z.uuid() });
export const linkAlertSchema = z.strictObject({ alertId: z.uuid() });
export const incidentNoteSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  /** Uploaded files (`POST /v1/uploads`) shown with the note; stored as `payload.attachments`. */
  attachmentIds: attachmentIdsSchema.optional(),
});
export type LinkTicket = z.infer<typeof linkTicketSchema>;
export type LinkAlert = z.infer<typeof linkAlertSchema>;
export type IncidentNote = z.infer<typeof incidentNoteSchema>;

export const incidentSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  /** `INC-12`. */
  key: z.string(),
  title: z.string(),
  severity: incidentSeveritySchema,
  status: incidentStatusSchema,
  commanderId: z.uuid().nullable(),
  rootCause: z.string().nullable(),
  /** `mock` means a fake recorded the thread and none exists. */
  discordThreadState: z.enum(['pending', 'created', 'mock', 'skipped', 'failed']),
  startedAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  serviceIds: z.array(z.uuid()),
  orgIds: z.array(z.uuid()),
  tickets: z.number().int().nonnegative(),
  alerts: z.number().int().nonnegative(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentTimelineEntrySchema = z.object({
  id: z.uuid(),
  type: z.enum(INCIDENT_TIMELINE_TYPES),
  actorType: z.enum(['user', 'system', 'ai', 'anonymous']),
  actorId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export type IncidentTimelineEntry = z.infer<typeof incidentTimelineEntrySchema>;

export const incidentDetailSchema = incidentSchema.extend({
  ticketIds: z.array(z.uuid()),
  alertIds: z.array(z.uuid()),
  timeline: z.array(incidentTimelineEntrySchema),
});
export type IncidentDetail = z.infer<typeof incidentDetailSchema>;

export const incidentListQuerySchema = z.object({
  status: incidentStatusSchema.optional(),
  /** `true`: only incidents that are not resolved. */
  open: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(300).optional(),
});
export type IncidentListQuery = z.infer<typeof incidentListQuerySchema>;
export const incidentListSchema = z.object({
  items: z.array(incidentSchema),
  nextCursor: z.string().nullable(),
});
export const incidentIdParamSchema = z.object({ id: z.uuid() });
export type IncidentIdParam = z.infer<typeof incidentIdParamSchema>;

// --- deploy feed (R-5.4) -------------------------------------------------------------------------

export const DEPLOY_SOURCES = ['ci', 'github'] as const;
export type DeploySource = (typeof DEPLOY_SOURCES)[number];

/**
 * The link to a deploy run as it may be stored and shown (T-207a C-6). A CI link can carry a secret in
 * the userinfo (`https://user:token@ci.example`) or in the query (`?token=...`), and this link is shown in
 * the console and handed to the AI, so the userinfo is refused on the way in, and the query and fragment
 * are cut. Null when the text is not an http(s) URL or carries userinfo (a row saved before the check).
 */
export function safeDeployUrl(value: string | null): string | null {
  if (value === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/**
 * What CI posts. `id` is the sender's own id for the deploy (a run id): the same `(source, id)` is one
 * deploy however often it is delivered. `service` is a catalog slug. Times are the sender's; they are
 * shown and used to line deploys up against an incident, never to decide anything.
 */
export const deployEventSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(200),
    service: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .min(2)
      .max(64),
    version: z.string().trim().min(1).max(200),
    env: z.string().trim().min(1).max(50),
    source: z.enum(DEPLOY_SOURCES).default('ci'),
    actor: z.string().trim().min(1).max(100).nullable().default(null),
    startedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    finishedAt: z.iso.datetime({ offset: true }).nullable().default(null),
    url: z
      .url({ protocol: /^https?$/ })
      .max(1000)
      .refine((value) => safeDeployUrl(value) !== null, {
        message: 'The link must not carry a user name or password',
      })
      // The query and the fragment are cut: a CI link often carries a token there.
      .transform((value) => safeDeployUrl(value) ?? value)
      .nullable()
      .default(null),
  })
  .refine(
    (event) =>
      event.startedAt === null ||
      event.finishedAt === null ||
      Date.parse(event.finishedAt) >= Date.parse(event.startedAt),
    { message: 'A deploy cannot finish before it started' },
  );
export type DeployEvent = z.infer<typeof deployEventSchema>;

/** `recorded: false` is a redelivery of a deploy we already have. */
export const deployRecordResultSchema = z.object({ recorded: z.boolean() });

export const deploySchema = z.object({
  id: z.uuid(),
  serviceId: z.uuid().nullable(),
  serviceSlug: z.string(),
  version: z.string(),
  env: z.string(),
  actor: z.string().nullable(),
  source: z.enum(DEPLOY_SOURCES),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
  url: z.string().nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type Deploy = z.infer<typeof deploySchema>;

export const deployListQuerySchema = z.object({
  serviceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DeployListQuery = z.infer<typeof deployListQuerySchema>;
export const deployListSchema = z.object({ items: z.array(deploySchema) });

// --- "what changed" (R-3.15, R-5.3, R-5.4) ------------------------------------------------------

/** `[ASSUMED]` an hour: most regressions show up soon after the change. Configurable per request. */
export const WHAT_CHANGED_DEFAULT_MINUTES = 60;

export const changesQuerySchema = z.object({
  windowMinutes: z.coerce.number().int().min(5).max(1440).default(WHAT_CHANGED_DEFAULT_MINUTES),
});
export type ChangesQuery = z.infer<typeof changesQuerySchema>;

export const REPO_CHANGE_KINDS = ['commit', 'pull_request', 'release'] as const;
export const repoChangeSchema = z.object({
  repo: z.string(),
  kind: z.enum(REPO_CHANGE_KINDS),
  /** A short sha, a PR number or a tag. */
  ref: z.string(),
  /** The repository's own words for it (a commit or PR title): shown to staff, never sent to chat. */
  title: z.string().nullable(),
  author: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
  url: z.string().nullable(),
});
export type RepoChange = z.infer<typeof repoChangeSchema>;

/**
 * What changed before the first alert of an incident. The window ends at the first alert linked to it
 * (else the incident's start), both stamped by the database, and reaches `minutes` back. Deploys are the
 * feed's (their times are the sender's and are only compared with that edge to line things up: a clock
 * that runs a little off shifts the edge a little, nothing is decided by it). `repoSource` says where the
 * repository changes came from: `none` (not connected), `fake` (an in-memory stand-in) or `live`.
 */
export const incidentChangesSchema = z.object({
  window: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    minutes: z.number().int().positive(),
    /** `alert` when the window ends at the first alert, `incident` when there is none. */
    endsAt: z.enum(['alert', 'incident']),
  }),
  deploys: z.array(deploySchema),
  repoSource: z.enum(['none', 'fake', 'live']),
  repoChanges: z.array(repoChangeSchema),
  /** True when the repository could not be read: the deploys above are still right. */
  repoUnavailable: z.boolean(),
});
export type IncidentChanges = z.infer<typeof incidentChangesSchema>;

// --- mass customer communication (R-3.14, N3) ----------------------------------------------------

/** Channels an incident update reaches: the customer-facing ones. Machine and internal tickets are skipped. */
export const INCIDENT_COMM_CHANNELS = ['gmail', 'line', 'portal'] as const;

export const draftCommSchema = z.strictObject({ body: z.string().trim().min(1).max(5000) });
export type DraftComm = z.infer<typeof draftCommSchema>;

export const INCIDENT_COMM_STATUSES = ['draft', 'sending', 'sent', 'cancelled'] as const;
export const incidentCommSchema = z.object({
  id: z.uuid(),
  incidentId: z.uuid(),
  body: z.string(),
  /** Who drafted it. Whoever drafted it, only a person sends it (N3). */
  origin: z.enum(['human', 'ai']),
  status: z.enum(INCIDENT_COMM_STATUSES),
  draftedBy: z.uuid().nullable(),
  sentBy: z.uuid().nullable(),
  /** The recipient count the sender saw and confirmed. */
  confirmedRecipients: z.number().int().nonnegative().nullable(),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type IncidentComm = z.infer<typeof incidentCommSchema>;
export const incidentCommListSchema = z.object({ items: z.array(incidentCommSchema) });

/** Who would get it now. `recipients` is the number to confirm; the rest is why a linked ticket is left out. */
export const incidentCommPreviewSchema = z.object({
  recipients: z.number().int().nonnegative(),
  skippedChannel: z.number().int().nonnegative(),
  skippedClosed: z.number().int().nonnegative(),
});
export type IncidentCommPreview = z.infer<typeof incidentCommPreviewSchema>;

export const commIdParamSchema = z.object({ id: z.uuid(), commId: z.uuid() });
export type CommIdParam = z.infer<typeof commIdParamSchema>;

/** Sending needs the count of recipients the person saw. If the audience changed since, the send is refused (409). */
export const sendCommSchema = z.strictObject({ confirmRecipients: z.number().int().min(0) });
export type SendComm = z.infer<typeof sendCommSchema>;

export const sendCommResultSchema = z.object({
  recipients: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type SendCommResult = z.infer<typeof sendCommResultSchema>;
