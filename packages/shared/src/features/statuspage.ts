/**
 * Public status page (T-204): this feature's own audit actions, ticket event types and queue names (T-200),
 * the HTTP schemas of the public page (`/v1/status`) and of staff administration (`/v1/status-page`).
 *
 * Browser-safe (no Node imports). The public schemas are ALLOW-LISTS: `z.strictObject` of exactly the
 * fields a visitor may read. A new field on a row never reaches the public page by accident; adding one
 * here is a decision. Nothing about an incident (title, commander, root cause, severity, organizations,
 * tickets) is on the list (PRD section 6.6, N1).
 */
import { z } from 'zod';

import { humanProofSchema } from '../human-proof.js';

/** Audit `action` strings written by this feature. Metadata holds ids and counts, never a body or an address. */
export const STATUSPAGE_AUDIT_ACTIONS = {
  componentCreate: 'status_component.create',
  componentUpdate: 'status_component.update',
  componentDelete: 'status_component.delete',
  postDraft: 'status_post.draft',
  postUpdate: 'status_post.update',
  /** A person published a post (N3). */
  postPublish: 'status_post.publish',
  postDelete: 'status_post.delete',
  maintenanceDraft: 'status_maintenance.draft',
  maintenanceUpdate: 'status_maintenance.update',
  /** A person published a maintenance window (N3). */
  maintenancePublish: 'status_maintenance.publish',
  maintenanceCancel: 'status_maintenance.cancel',
  /** Someone asked to subscribe (the address is not recorded). */
  subscriptionRequest: 'status_subscription.request',
  subscriptionConfirm: 'status_subscription.confirm',
  subscriptionUnsubscribe: 'status_subscription.unsubscribe',
  subscriptionRateLimited: 'status_subscription.rate_limited',
  /** A subscribe request whose proof of work (ADR-007) was missing, wrong, spent or too quick. */
  subscriptionVerificationFailed: 'status_subscription.verification_failed',
} as const satisfies Record<string, string>;

/**
 * Hard bounces in a row after which an address stops getting status mail (T-207a C-7). A hard bounce is a
 * permanent 5xx for the mailbox itself; an address that keeps refusing is not read by anyone, and mailing it
 * only damages the sender's reputation. `[ASSUMED]`
 */
export const STATUS_BOUNCE_LIMIT = 3;

/** `ticket_event.type` strings written by this feature. */
export const STATUSPAGE_TICKET_EVENTS = {} as const satisfies Record<string, string>;

/** BullMQ queue names owned by this feature (producer: api; consumer: worker). */
export const STATUSPAGE_QUEUES = {
  statuspage: 'statuspage',
} as const satisfies Record<string, string>;

export const STATUSPAGE_JOBS = {
  /** Sends the double opt-in email of one subscription. `jobId` is per subscription and nonce. */
  confirm: 'confirm',
  /** Tells the confirmed subscribers about one published post or window. `jobId` is per post or window. */
  notify: 'notify',
} as const;

/** Ids only: the worker derives the signed links itself, so no link rides the queue. */
export const statusConfirmJobSchema = z.object({ subscriptionId: z.uuid() });
export type StatusConfirmJob = z.infer<typeof statusConfirmJobSchema>;

export const statusNotifyJobSchema = z.object({
  kind: z.enum(['post', 'maintenance']),
  refId: z.uuid(),
});
export type StatusNotifyJob = z.infer<typeof statusNotifyJobSchema>;

// --- vocabulary ----------------------------------------------------------------------------------

export const STATUS_COMPONENT_STATUSES = [
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance',
] as const;
export type StatusComponentStatus = (typeof STATUS_COMPONENT_STATUSES)[number];
export const statusComponentStatusSchema = z.enum(STATUS_COMPONENT_STATUSES);

export const STATUS_POST_PHASES = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
] as const;
export type StatusPostPhase = (typeof STATUS_POST_PHASES)[number];
export const statusPostPhaseSchema = z.enum(STATUS_POST_PHASES);

export const STATUS_POST_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type StatusPostImpact = (typeof STATUS_POST_IMPACTS)[number];
export const statusPostImpactSchema = z.enum(STATUS_POST_IMPACTS);

export const STATUS_LOCALES = ['en', 'th'] as const;
export type StatusLocale = (typeof STATUS_LOCALES)[number];
export const statusLocaleSchema = z.enum(STATUS_LOCALES);

/** The history window the page shows (R-6.1). */
export const STATUS_HISTORY_DAYS = 90;

/** What the page says overall: the worst thing any listed component is doing. */
export const STATUS_OVERALL = ['operational', 'degraded', 'outage', 'maintenance'] as const;
export type StatusOverall = (typeof STATUS_OVERALL)[number];

/** The overall state from the statuses of the public components. Maintenance never hides an outage. */
export function overallStatus(statuses: readonly StatusComponentStatus[]): StatusOverall {
  if (statuses.some((status) => status === 'major_outage' || status === 'partial_outage')) {
    return 'outage';
  }
  if (statuses.some((status) => status === 'degraded_performance')) return 'degraded';
  if (statuses.some((status) => status === 'under_maintenance')) return 'maintenance';
  return 'operational';
}

// --- wording templates (R-6.3) -------------------------------------------------------------------

/**
 * Customer-safe wording by phase and language. The template names the affected components and nothing
 * else: no incident title, cause, system name, count or time. A person edits it before publishing, and
 * the AI, when it drafts, starts from the same shape.
 */
const TEMPLATES: Readonly<
  Record<
    StatusLocale,
    Readonly<Record<StatusPostPhase, { title: string; body: (components: string) => string }>>
  >
> = {
  en: {
    investigating: {
      title: 'We are investigating an issue',
      body: (c) =>
        `We are investigating an issue affecting ${c}. We will post an update as soon as we know more.`,
    },
    identified: {
      title: 'We have identified the issue',
      body: (c) =>
        `We have identified the cause of the issue affecting ${c} and are working on a fix.`,
    },
    monitoring: {
      title: 'A fix is in place',
      body: (c) =>
        `A fix has been applied for the issue affecting ${c}. We are monitoring the results.`,
    },
    resolved: {
      title: 'The issue is resolved',
      body: (c) => `The issue affecting ${c} has been resolved. Thank you for your patience.`,
    },
  },
  th: {
    investigating: {
      title: 'เรากำลังตรวจสอบปัญหา',
      body: (c) =>
        `เรากำลังตรวจสอบปัญหาที่กระทบ ${c} และจะแจ้งความคืบหน้าทันทีที่ทราบข้อมูลเพิ่มเติม`,
    },
    identified: {
      title: 'เราพบสาเหตุของปัญหาแล้ว',
      body: (c) => `เราพบสาเหตุของปัญหาที่กระทบ ${c} แล้ว และกำลังดำเนินการแก้ไข`,
    },
    monitoring: {
      title: 'แก้ไขเรียบร้อย กำลังติดตามผล',
      body: (c) => `เราแก้ไขปัญหาที่กระทบ ${c} แล้ว และกำลังติดตามผล`,
    },
    resolved: {
      title: 'ปัญหาได้รับการแก้ไขแล้ว',
      body: (c) => `ปัญหาที่กระทบ ${c} ได้รับการแก้ไขแล้ว ขอบคุณที่รอคอย`,
    },
  },
};

export function statusPostTemplate(input: {
  readonly phase: StatusPostPhase;
  readonly locale: StatusLocale;
  readonly componentNames: readonly string[];
}): { title: string; body: string } {
  const entry = TEMPLATES[input.locale][input.phase];
  const names =
    input.componentNames.length > 0
      ? input.componentNames.join(', ')
      : input.locale === 'th'
        ? 'บริการของเรา'
        : 'our services';
  return { title: entry.title, body: entry.body(names) };
}

// --- the public page (allow-lists) ---------------------------------------------------------------

export const publicComponentRefSchema = z.strictObject({ slug: z.string(), name: z.string() });

export const publicComponentSchema = z.strictObject({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: statusComponentStatusSchema,
});
export type PublicComponent = z.infer<typeof publicComponentSchema>;

export const publicPostSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  phase: statusPostPhaseSchema,
  impact: statusPostImpactSchema,
  publishedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  components: z.array(publicComponentRefSchema),
});
export type PublicPost = z.infer<typeof publicPostSchema>;

export const publicMaintenanceSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  components: z.array(publicComponentRefSchema),
});
export type PublicMaintenance = z.infer<typeof publicMaintenanceSchema>;

export const publicStatusSchema = z.strictObject({
  overall: z.enum(STATUS_OVERALL),
  components: z.array(publicComponentSchema),
  /** Published posts whose phase is not `resolved`, newest first. */
  activePosts: z.array(publicPostSchema),
  /** Published windows that have started and not ended. */
  ongoingMaintenance: z.array(publicMaintenanceSchema),
  /** Published windows that have not started. */
  upcomingMaintenance: z.array(publicMaintenanceSchema),
  generatedAt: z.iso.datetime({ offset: true }),
});
export type PublicStatus = z.infer<typeof publicStatusSchema>;

export const publicHistorySchema = z.strictObject({
  days: z.number().int(),
  posts: z.array(publicPostSchema),
  maintenance: z.array(publicMaintenanceSchema),
});
export type PublicHistory = z.infer<typeof publicHistorySchema>;

// --- subscriptions (public) ----------------------------------------------------------------------

/**
 * A plain address: lower case, ASCII, `local@domain.tld` and nothing else. A display-name form such as
 * `Name <victim@example.test>`, a comma list, a quoted local part or a comment is refused outright, so
 * what is stored and mailed is exactly one mailbox and the per-address limit counts that mailbox.
 */
export const statusEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .regex(/^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, 'Not an email address');

/**
 * The key the per-address limit counts under: the mailbox without a `+tag`, so `a+1@x`, `a+2@x` and `a@x`
 * are one address for the limit (they reach the same person) while the address that is mailed stays as typed.
 */
export function statusEmailLimitKey(email: string): string {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const plus = local.indexOf('+');
  return `${plus > 0 ? local.slice(0, plus) : local}${email.slice(at)}`.toLowerCase();
}

export const subscribeSchema = z.strictObject({
  email: statusEmailSchema,
  locale: statusLocaleSchema.default('en'),
  /** The solved challenge of `GET /v1/status/subscriptions/challenge` (proof of work, ADR-007, T-207a C-3). */
  verification: humanProofSchema,
  /** Honeypot: a person never sees this field; anything but empty is a script. */
  website: z.string().max(200).optional(),
});
export type Subscribe = z.infer<typeof subscribeSchema>;

/** The signed link token. It travels in the body (the page reads it from the URL fragment), never in a URL. */
export const subscriptionTokenSchema = z.strictObject({ token: z.string().min(10).max(300) });
export type SubscriptionToken = z.infer<typeof subscriptionTokenSchema>;

/** Always the same answer to a subscribe request, whether or not the address is known (no enumeration). */
export const subscribeResultSchema = z.strictObject({ status: z.literal('check_your_email') });
export const subscriptionResultSchema = z.strictObject({
  status: z.enum(['confirmed', 'unsubscribed']),
});

// --- staff administration ------------------------------------------------------------------------

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Lower case letters, digits and single dashes');

export const statusComponentSchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  serviceId: z.uuid().nullable(),
  public: z.boolean(),
  position: z.number().int(),
  status: statusComponentStatusSchema,
});
export type StatusComponent = z.infer<typeof statusComponentSchema>;
export const statusComponentListSchema = z.strictObject({ items: z.array(statusComponentSchema) });

export const createStatusComponentSchema = z.strictObject({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().default(null),
  serviceId: z.uuid().nullable().default(null),
  public: z.boolean().default(false),
  position: z.number().int().min(0).max(10_000).default(0),
});
export type CreateStatusComponent = z.infer<typeof createStatusComponentSchema>;

export const updateStatusComponentSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable(),
    serviceId: z.uuid().nullable(),
    public: z.boolean(),
    position: z.number().int().min(0).max(10_000),
    status: statusComponentStatusSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateStatusComponent = z.infer<typeof updateStatusComponentSchema>;

export const statusIdParamSchema = z.object({ id: z.uuid() });
export type StatusIdParam = z.infer<typeof statusIdParamSchema>;

export const statusPostStaffSchema = z.strictObject({
  id: z.uuid(),
  incidentId: z.uuid().nullable(),
  title: z.string(),
  body: z.string(),
  phase: statusPostPhaseSchema,
  impact: statusPostImpactSchema,
  state: z.enum(['draft', 'published']),
  origin: z.enum(['human', 'ai']),
  draftedBy: z.uuid().nullable(),
  publishedBy: z.uuid().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  componentIds: z.array(z.uuid()),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type StatusPostStaff = z.infer<typeof statusPostStaffSchema>;
export const statusPostListSchema = z.strictObject({
  items: z.array(statusPostStaffSchema),
  nextCursor: z.string().nullable(),
});

export const statusPostListQuerySchema = z.object({
  state: z.enum(['draft', 'published']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type StatusPostListQuery = z.infer<typeof statusPostListQuerySchema>;

/** A draft written by a person. `incidentId` only links it; no wording is taken from the incident. */
export const createStatusPostSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  phase: statusPostPhaseSchema.default('investigating'),
  impact: statusPostImpactSchema.default('minor'),
  componentIds: z.array(z.uuid()).max(50).default([]),
  incidentId: z.uuid().nullable().default(null),
});
export type CreateStatusPost = z.infer<typeof createStatusPostSchema>;

/** A draft from a template, for an incident: the wording is the template's, not the incident's. */
export const draftFromIncidentSchema = z.strictObject({
  incidentId: z.uuid(),
  componentIds: z.array(z.uuid()).min(1).max(50),
  phase: statusPostPhaseSchema.default('investigating'),
  impact: statusPostImpactSchema.default('minor'),
  locale: statusLocaleSchema.default('en'),
});
export type DraftFromIncident = z.infer<typeof draftFromIncidentSchema>;

export const updateStatusPostSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    phase: statusPostPhaseSchema,
    impact: statusPostImpactSchema,
    componentIds: z.array(z.uuid()).max(50),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateStatusPost = z.infer<typeof updateStatusPostSchema>;

export const publishResultSchema = z.strictObject({
  post: statusPostStaffSchema,
  /** Confirmed subscribers who will be told. */
  subscribers: z.number().int(),
});

export const statusMaintenanceStaffSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  state: z.enum(['draft', 'published', 'cancelled']),
  origin: z.enum(['human', 'ai']),
  publishedBy: z.uuid().nullable(),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  componentIds: z.array(z.uuid()),
});
export type StatusMaintenanceStaff = z.infer<typeof statusMaintenanceStaffSchema>;
export const statusMaintenanceListSchema = z.strictObject({
  items: z.array(statusMaintenanceStaffSchema),
});

export const createStatusMaintenanceSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    componentIds: z.array(z.uuid()).max(50).default([]),
  })
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
    message: 'The window must end after it starts',
    path: ['endsAt'],
  });
export type CreateStatusMaintenance = z.infer<typeof createStatusMaintenanceSchema>;

export const updateStatusMaintenanceSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    componentIds: z.array(z.uuid()).max(50),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export type UpdateStatusMaintenance = z.infer<typeof updateStatusMaintenanceSchema>;

export const subscriberSummarySchema = z.strictObject({
  pending: z.number().int(),
  confirmed: z.number().int(),
  unsubscribed: z.number().int(),
});
