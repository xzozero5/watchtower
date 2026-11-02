import { z } from 'zod';

/**
 * Roles and permission strings (PRD section 2.2). `[ASSUMED]` the exact matrix.
 *
 * The database is the source of truth at runtime: `permissions` and `role_permissions` are seeded
 * by migration 0001 and a head can change them through the API without a deploy. This module holds
 * the permission vocabulary that route decorators refer to and the defaults the seed must match
 * (an integration test compares the two so they cannot drift).
 */

export const ROLES = ['agent', 'lead', 'head', 'dev', 'client', 'system'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const STAFF_ROLES = ['agent', 'lead', 'head'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/**
 * Everyone who works inside the workspace and may sign in with the company account: the staff roles
 * and `dev` (T-137). `dev` is deliberately NOT in `STAFF_ROLES`: that list decides who tickets are
 * routed to (assignment, round robin, on-shift alerts), and a ticket must never be assigned to a dev;
 * a dev picks work up through `ticket.dev_owner_id` instead.
 */
export const WORKSPACE_ROLES = [...STAFF_ROLES, 'dev'] as const satisfies readonly Role[];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Every permission string a route may require, with what it allows. */
export const PERMISSIONS = {
  'ticket.read': 'View all tickets',
  'ticket.handle': 'Handle tickets: assign, change status, add internal notes',
  'ticket.reply': 'Reply to a customer on any channel',
  'ticket.create': 'Create a ticket',
  'ticket.read.org': 'View the tickets of the caller own organization (client)',
  'ticket.reply.own': 'Reply on a ticket of the caller own organization (client)',
  'ai.draft.review': 'Approve, edit or reject AI drafts',
  'ai.autonomy.set':
    'Change AI autonomy stage per intent (0-2 in Phase 1; stage 3 and above is the owner decision)',
  'ai.autonomy.set.any': 'Change AI autonomy stage per intent to any stage',
  'investigate.run': 'Run read-only investigation tools',
  'incident.create': 'Create an incident',
  'incident.manage': 'Close incidents and publish status page posts',
  'statuspage.subscribe': 'Subscribe to the status page',
  'shift.clock': 'Clock in and out of a shift',
  'handoff.write': 'Write a shift handoff',
  'roster.manage': 'Manage the roster and shift swaps',
  'performance.read.own': 'View own performance',
  'performance.read.all': 'View per-agent performance',
  'kb.read': 'Read knowledge base articles',
  'kb.write': 'Write knowledge base drafts',
  'kb.approve': 'Approve knowledge base articles',
  'integration.manage': 'Manage integrations',
  'ai.provider.manage': 'Manage the AI provider and model settings',
  'apikey.manage': 'Manage API keys',
  'org.manage': 'Manage organizations and contacts',
  'sla.manage': 'Manage SLA policies',
  'queue.manage': 'Manage team queues and their members',
  'intent.manage': 'Create and edit intents (not their autonomy stage)',
  'workflow.manage': 'Change which ticket status transitions are allowed',
  'user.read': 'List users',
  'user.manage': 'Create users and change their role or status',
  'client.invite': 'Invite client users to an organization',
  'audit.read': 'View the audit log',
  'ceo.view': 'CEO view and exports',
  'pii.export': 'Export personal data',
  'rbac.manage': 'Change which permissions each role has',
  'session.revoke.any': 'Force logout of any user',
  'auth.session.self': 'View and revoke the caller own sessions',
  // Phase 1 (T-123a, migration 0006). `[ASSUMED]`, grants are explained above `AGENT`.
  'inbound.read': 'View received messages, including mail that did not become a ticket',
  'outbox.manage': 'View and resend dead-lettered outbound messages',
  'view.share': 'Share a saved view with the team',
  'ai.emergency_switch': 'Use the emergency switch that sends every intent back to draft-only',
  'shift.note.write': 'Write shift notes',
  'handoff.ack': 'Acknowledge the items of a shift handoff',
  'csat.read': 'View CSAT responses',
  'ai.run.read': 'View AI run records: prompt version, model, tools and cost',
  // T-122e (migration 0014).
  'ticket.cancel.any': "Undo a colleague's send before it goes out",
  // Phase 1 (T-107a, migration 0019_kb).
  'kb.read.customer': 'Search the customer-visible knowledge base (client)',
  'kb.publish.break_glass':
    'Publish a knowledge base article without a second person, with a reason (head)',
  // Phase 2 (T-200, migration 0040_phase2_permissions). `[ASSUMED]`, grants are explained above `AGENT`.
  'alert.read': 'View alerts and the service catalog',
  'alert.ack': 'Acknowledge an alert',
  'alert.manage': 'Snooze or resolve alerts by hand and manage escalation policies',
  'service.manage': 'Create and edit services in the catalog',
  'investigate.adhoc': 'Run an ad-hoc investigation query outside a ticket template',
  'metric.read': 'View product usage metrics',
  'metric.manage': 'Create and edit product usage metric definitions',
  'org.health.read': 'View the Client Health Score of an organization',
  'dashboard.ops.read': 'View the ops dashboard and the service status panel',
  // T-137 (migration 0080_dev_role_manual_ticket). `[ASSUMED]`, grants are explained above `DEV`.
  'ticket.read.masked':
    'Read any ticket with personal data masked (email, phone, names, message text through the redactor)',
  'ticket.dev.work':
    'Developer work on a ticket: internal notes, open and waiting_on_dev, pick up as dev owner, link an incident or deploy',
  'ticket.dev.release.any': 'Let go of the dev owner of any ticket (a developer who is away)',
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];
export const permissionSchema = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

/**
 * Phase 1 grants (T-123a) `[ASSUMED]`, in the style of PRD section 2.2; `po` confirms them:
 * - agent: `inbound.read` (the "Other mail" view), `shift.note.write`, `handoff.ack` (R-7.x: every
 *   person on shift writes notes and acknowledges the handoff they receive).
 * - lead adds `view.share` (team views), `ai.emergency_switch` (PRD section 6.4: it only moves
 *   intents to stage 2, the safe direction), `csat.read` and `ai.run.read` (quality review).
 * - head adds `outbox.manage` (PRD section 8.3: dead letters are visible to the head).
 * - client and system get none.
 * Phase 2 (T-200, `[ASSUMED]`): agent `alert.read`, `alert.ack` and `dashboard.ops.read` (whoever is on shift
 * answers an alert and sees the service panel); lead adds `alert.manage`, `service.manage`,
 * `investigate.adhoc`, `metric.read` and `org.health.read`; head adds `metric.manage` (a metric
 * template is SQL against product data: head only, audited). The client gets none of them.
 * Migration 0006 seeds the same rows; the integration tests compare them with this file.
 */
const AGENT: readonly Permission[] = [
  'ticket.read',
  'ticket.handle',
  'ticket.reply',
  'ticket.create',
  'ai.draft.review',
  'investigate.run',
  'incident.create',
  'shift.clock',
  'handoff.write',
  'performance.read.own',
  'kb.read',
  'kb.write',
  'auth.session.self',
  'inbound.read',
  'shift.note.write',
  'handoff.ack',
  'alert.read',
  'alert.ack',
  'dashboard.ops.read',
];

const LEAD: readonly Permission[] = [
  ...AGENT,
  'ai.autonomy.set',
  'incident.manage',
  'roster.manage',
  'performance.read.all',
  'kb.approve',
  'org.manage',
  'client.invite',
  'user.read',
  'ceo.view',
  'queue.manage',
  'intent.manage',
  'view.share',
  'ai.emergency_switch',
  'csat.read',
  'ai.run.read',
  'ticket.cancel.any',
  'ticket.dev.release.any',
  'alert.manage',
  'service.manage',
  'investigate.adhoc',
  'metric.read',
  'org.health.read',
];

const HEAD: readonly Permission[] = [
  ...LEAD,
  'ai.autonomy.set.any',
  'integration.manage',
  'ai.provider.manage',
  'apikey.manage',
  'sla.manage',
  'workflow.manage',
  'user.manage',
  'audit.read',
  'pii.export',
  'rbac.manage',
  'session.revoke.any',
  'outbox.manage',
  'kb.publish.break_glass',
  'metric.manage',
];

/**
 * The `dev` role (T-137, `po` decision `[ASSUMED]`): reads every ticket with personal data masked
 * (`ticket.read.masked`, not `ticket.read`), writes internal notes, moves a ticket between `open` and
 * `waiting_on_dev`, picks work up for themselves and links an incident or a deploy (`ticket.dev.work`),
 * and runs the read-only investigation of a ticket (`investigate.run`). No reply to a customer, no AI draft
 * approval (N3), no ad-hoc investigation, no shift or handoff duty, no incident creation.
 */
const DEV: readonly Permission[] = [
  'ticket.read.masked',
  'ticket.dev.work',
  'investigate.run',
  'auth.session.self',
];

const CLIENT: readonly Permission[] = [
  'ticket.read.org',
  'ticket.create',
  'ticket.reply.own',
  'statuspage.subscribe',
  'auth.session.self',
  'kb.read.customer',
];

/** What migration 0001 seeds. `system` has nothing: each service identity is granted scoped permissions. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  agent: AGENT,
  lead: LEAD,
  head: HEAD,
  dev: DEV,
  client: CLIENT,
  system: [],
};

/**
 * Permissions that only the head role can hold. They are ignored on any other role (a row put in
 * `role_permissions` by hand or by a mistaken grant does nothing) and refused by the role editor, so
 * `rbac.manage` cannot hand the break-glass publication to anyone else.
 */
export const HEAD_ONLY_PERMISSIONS = [
  'kb.publish.break_glass',
] as const satisfies readonly Permission[];

export function isHeadOnlyPermission(permission: string): boolean {
  return (HEAD_ONLY_PERMISSIONS as readonly string[]).includes(permission);
}

/** Permissions a head can never remove from the head role, or nobody could undo a mistake. */
export const LOCKED_HEAD_PERMISSIONS = [
  'rbac.manage',
  'user.manage',
  'audit.read',
  'session.revoke.any',
] as const satisfies readonly Permission[];

/**
 * Which rows of an organization-scoped table a caller may see. Staff see every organization; a
 * client sees exactly one. Build it from the principal, then give it to the query layer.
 */
export type OrgScope = { readonly kind: 'all' } | { readonly kind: 'org'; readonly orgId: string };
