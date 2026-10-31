import { z } from 'zod';

/**
 * Roles and permission strings (PRD section 2.2). `[ASSUMED]` the exact matrix.
 *
 * The database is the source of truth at runtime: `permissions` and `role_permissions` are seeded
 * by migration 0001 and a head can change them through the API without a deploy. This module holds
 * the permission vocabulary that route decorators refer to and the defaults the seed must match
 * (an integration test compares the two so they cannot drift).
 */

export const ROLES = ['agent', 'lead', 'head', 'client', 'system'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

export const STAFF_ROLES = ['agent', 'lead', 'head'] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/** Every permission string a route may require, with what it allows. */
export const PERMISSIONS = {
  'ticket.read': 'View all tickets',
  'ticket.handle': 'Handle tickets: assign, change status, add internal notes',
  'ticket.reply': 'Reply to a customer on any channel',
  'ticket.create': 'Create a ticket',
  'ticket.read.org': 'View the tickets of the caller own organization (client)',
  'ticket.reply.own': 'Reply on a ticket of the caller own organization (client)',
  'ai.draft.review': 'Approve, edit or reject AI drafts',
  'ai.autonomy.set': 'Change AI autonomy stage per intent, up to stage 3',
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
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];
export const permissionSchema = z.enum(PERMISSION_KEYS as [Permission, ...Permission[]]);

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

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
];

const CLIENT: readonly Permission[] = [
  'ticket.read.org',
  'ticket.create',
  'ticket.reply.own',
  'statuspage.subscribe',
  'auth.session.self',
];

/** What migration 0001 seeds. `system` has nothing: each service identity is granted scoped permissions. */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  agent: AGENT,
  lead: LEAD,
  head: HEAD,
  client: CLIENT,
  system: [],
};

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
