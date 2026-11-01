import { z } from 'zod';

import { emailSchema } from './auth.js';
import { cursorSchema, jsonRecordSchema, pageLimit, pageOf } from './common.js';
import {
  holidayRecordSchema,
  holidaySchema,
  slaTargetsSchema,
  ticketPrioritySchema,
  timezoneSchema,
  weeklyHoursSchema,
  DEFAULT_WEEKLY_HOURS,
} from './sla.js';

/**
 * HTTP contract of organizations, contacts, team queues, intents, SLA policies and business
 * calendars (PRD section 7). Reference data that tickets point at.
 */

// --- organizations ---

/**
 * The tiers a fresh database starts with (migration 0003 seeds the `org_tier` table with them).
 * Tiers are data: the table decides which slugs exist, and an admin can add more later. `[ASSUMED]`
 * Gold/Silver/Standard from PRD R-1.6.
 */
export const ORG_TIERS = ['gold', 'silver', 'standard'] as const;
/** The slug of a row of `org_tier`. */
export type OrgTier = string;
/**
 * The shape of a tier slug. Whether it exists is the database's call (a foreign key to `org_tier`),
 * so a tier an admin adds works without a code change; an unknown one is answered with 400.
 */
export const orgTierSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'expected a tier slug such as "gold"');

export const ORG_STATUSES = ['active', 'inactive'] as const;
export const orgStatusSchema = z.enum(ORG_STATUSES);

/**
 * Public mailbox providers. An organization claims an email domain so that anyone who proves they
 * own an address there can sign in as that organization's client; claiming a mailbox provider would
 * let every customer of that provider in, so these can never be organization domains.
 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.th',
  'yahoo.co.uk',
  'outlook.com',
  'outlook.co.th',
  'hotmail.com',
  'hotmail.co.th',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'zoho.com',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'line.me',
];

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.includes(domain.trim().toLowerCase());
}

const DOMAIN_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const orgDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(DOMAIN_PATTERN, 'expected a domain such as example.com')
  .refine((domain) => !isFreeMailDomain(domain), {
    message: 'a public mailbox provider cannot be an organization domain',
  });

/** The domain of an address, lower-cased, or null when it has none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  tier: orgTierSchema,
  slaPolicyId: z.uuid().nullable(),
  domains: z.array(z.string()),
  lineGroupIds: z.array(z.string()),
  healthScore: z.number().int().min(0).max(100).nullable(),
  primaryContactId: z.uuid().nullable(),
  /** Number of contacts of the organization. Null for a client, who is not shown their colleagues' count. */
  contactCount: z.number().int().min(0).nullable(),
  notes: z.string(),
  status: orgStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tier: orgTierSchema.default('standard'),
  slaPolicyId: z.uuid().optional(),
  domains: z.array(orgDomainSchema).max(20).default([]),
  lineGroupIds: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  notes: z.string().max(5000).default(''),
});
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    tier: orgTierSchema.optional(),
    slaPolicyId: z.uuid().nullable().optional(),
    domains: z.array(orgDomainSchema).max(20).optional(),
    lineGroupIds: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    healthScore: z.number().int().min(0).max(100).nullable().optional(),
    primaryContactId: z.uuid().nullable().optional(),
    notes: z.string().max(5000).optional(),
    status: orgStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export const organizationListQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  status: orgStatusSchema.optional(),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type OrganizationListQuery = z.infer<typeof organizationListQuerySchema>;
export const organizationPageSchema = pageOf(organizationSchema);

/** One row of `org_tier` (T-127; creating and editing tiers is T-121). */
export const orgTierRecordSchema = z.object({
  slug: orgTierSchema,
  name: z.string(),
  sortOrder: z.number().int(),
});
export type OrgTierRecord = z.infer<typeof orgTierRecordSchema>;
export const orgTierListSchema = z.object({ tiers: z.array(orgTierRecordSchema) });
export type OrgTierList = z.infer<typeof orgTierListSchema>;

// --- contacts ---

export const contactSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  name: z.string(),
  emails: z.array(z.string()),
  lineUserId: z.string().nullable(),
  phone: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  roleInOrg: z.string().nullable(),
  notificationPrefs: jsonRecordSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Contact = z.infer<typeof contactSchema>;

export const createContactSchema = z.object({
  orgId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  emails: z.array(emailSchema).min(1).max(10),
  lineUserId: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  roleInOrg: z.string().trim().min(1).max(100).optional(),
  notificationPrefs: jsonRecordSchema.optional(),
});
export type CreateContact = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    emails: z.array(emailSchema).min(1).max(10).optional(),
    lineUserId: z.string().trim().min(1).max(100).nullable().optional(),
    phone: z.string().trim().min(3).max(40).nullable().optional(),
    roleInOrg: z.string().trim().min(1).max(100).nullable().optional(),
    notificationPrefs: jsonRecordSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateContact = z.infer<typeof updateContactSchema>;

export const contactListQuerySchema = z.object({
  orgId: z.uuid().optional(),
  /** Matches the name or an address. */
  q: z.string().trim().min(1).max(200).optional(),
  limit: pageLimit(50, 200),
  cursor: cursorSchema.optional(),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
export const contactPageSchema = pageOf(contactSchema);

// --- team queues ---

/**
 * How a new ticket of the queue gets its assignee (R-1.7). Every automatic mode picks only people
 * who are clocked in (T-111): `round_robin` takes turns, `load_balanced` gives it to the one with
 * the fewest open tickets, `stay_with_last_handler` to whoever handled the requester's last ticket
 * (and falls back to load balancing).
 */
export const ASSIGNMENT_MODES = [
  'manual',
  'round_robin',
  'load_balanced',
  'stay_with_last_handler',
] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];
export const assignmentModeSchema = z.enum(ASSIGNMENT_MODES);

export const teamQueueSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  assignmentMode: assignmentModeSchema,
  isDefault: z.boolean(),
  members: z.array(
    z.object({
      userId: z.uuid(),
      name: z.string(),
      role: z.string(),
      status: z.string(),
    }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TeamQueue = z.infer<typeof teamQueueSchema>;
export const teamQueueListSchema = z.object({ queues: z.array(teamQueueSchema) });

export const createTeamQueueSchema = z.object({
  name: z.string().trim().min(1).max(100),
  assignmentMode: assignmentModeSchema.default('manual'),
  isDefault: z.boolean().default(false),
  /** Staff user ids. */
  memberIds: z.array(z.uuid()).max(200).default([]),
});
export type CreateTeamQueue = z.infer<typeof createTeamQueueSchema>;

export const updateTeamQueueSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    assignmentMode: assignmentModeSchema.optional(),
    isDefault: z.boolean().optional(),
    memberIds: z.array(z.uuid()).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateTeamQueue = z.infer<typeof updateTeamQueueSchema>;

// --- intents (PRD section 3.1, 7) ---

/** N3: every intent starts at stage 2, draft-for-approval. */
export const DEFAULT_AUTONOMY_STAGE = 2;

export const INTENT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
export const intentKeySchema = z
  .string()
  .regex(INTENT_KEY_PATTERN, 'lower snake_case, 2 to 63 characters');

export const replyTemplateSchema = z.object({
  key: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

const intentBase = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000),
  /** What an investigation of this kind of ticket usually needs (PRD section 3.1). */
  typicalEvidence: z.string().max(2000),
  defaultPriority: ticketPrioritySchema,
  slaPolicyId: z.uuid().nullable(),
  allowedTools: z.array(z.string().trim().min(1).max(100)).max(50),
  replyTemplates: z.array(replyTemplateSchema).max(50),
  isActive: z.boolean(),
};

export const intentSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  ...intentBase,
  runbookArticleId: z.uuid().nullable(),
  procedureVersionId: z.uuid().nullable(),
  /** Changed only by the AI autonomy endpoints (Phase 1), never by editing an intent. */
  autonomyStage: z.number().int().min(0).max(4),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Intent = z.infer<typeof intentSchema>;

/** The part of an intent a client may see when choosing a category. */
export const clientIntentSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
});
export const intentListSchema = z.object({
  intents: z.array(z.union([intentSchema, clientIntentSchema])),
});

export const createIntentSchema = z.object({
  key: intentKeySchema,
  name: intentBase.name,
  description: intentBase.description.default(''),
  typicalEvidence: intentBase.typicalEvidence.default(''),
  defaultPriority: intentBase.defaultPriority.default('P3'),
  slaPolicyId: intentBase.slaPolicyId.default(null),
  allowedTools: intentBase.allowedTools.default([]),
  replyTemplates: intentBase.replyTemplates.default([]),
  isActive: intentBase.isActive.default(true),
});
export type CreateIntent = z.infer<typeof createIntentSchema>;

export const updateIntentSchema = z
  .object({
    name: intentBase.name.optional(),
    description: intentBase.description.optional(),
    typicalEvidence: intentBase.typicalEvidence.optional(),
    defaultPriority: intentBase.defaultPriority.optional(),
    slaPolicyId: intentBase.slaPolicyId.optional(),
    allowedTools: intentBase.allowedTools.optional(),
    replyTemplates: intentBase.replyTemplates.optional(),
    isActive: intentBase.isActive.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateIntent = z.infer<typeof updateIntentSchema>;

/** One file in `examples/intents/`. Loaded by the seed code; never hard-coded in the app. */
export const intentDefinitionSchema = z.object({
  key: intentKeySchema,
  name: intentBase.name,
  description: intentBase.description,
  typicalEvidence: intentBase.typicalEvidence,
  defaultPriority: intentBase.defaultPriority,
  allowedTools: intentBase.allowedTools.default([]),
  replyTemplates: intentBase.replyTemplates.default([]),
});
export type IntentDefinition = z.infer<typeof intentDefinitionSchema>;

// --- SLA policies and business calendars ---

export const slaPolicySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** The organization tier this policy is the default for. */
  tier: orgTierSchema.nullable(),
  targets: slaTargetsSchema,
  businessCalendarId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SlaPolicy = z.infer<typeof slaPolicySchema>;
export const slaPolicyListSchema = z.object({ policies: z.array(slaPolicySchema) });

export const createSlaPolicySchema = z.object({
  name: z.string().trim().min(1).max(200),
  tier: orgTierSchema.optional(),
  targets: slaTargetsSchema,
  businessCalendarId: z.uuid().optional(),
});
export type CreateSlaPolicy = z.infer<typeof createSlaPolicySchema>;

export const updateSlaPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    tier: orgTierSchema.nullable().optional(),
    targets: slaTargetsSchema.optional(),
    businessCalendarId: z.uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateSlaPolicy = z.infer<typeof updateSlaPolicySchema>;

const holidayList = z
  .array(holidaySchema)
  .max(400)
  .refine((holidays) => new Set(holidays.map((holiday) => holiday.date)).size === holidays.length, {
    message: 'a date is listed twice',
  });

export const businessCalendarSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  timezone: z.string(),
  hours: weeklyHoursSchema,
  holidays: z.array(holidayRecordSchema),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BusinessCalendarRecord = z.infer<typeof businessCalendarSchema>;
export const businessCalendarListSchema = z.object({ calendars: z.array(businessCalendarSchema) });

export const createBusinessCalendarSchema = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: timezoneSchema.default('Asia/Bangkok'),
  hours: weeklyHoursSchema.default(DEFAULT_WEEKLY_HOURS),
  holidays: holidayList.default([]),
  isDefault: z.boolean().default(false),
});
export type CreateBusinessCalendar = z.infer<typeof createBusinessCalendarSchema>;

export const updateBusinessCalendarSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timezone: timezoneSchema.optional(),
    hours: weeklyHoursSchema.optional(),
    holidays: holidayList.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateBusinessCalendar = z.infer<typeof updateBusinessCalendarSchema>;
