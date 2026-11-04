import { z } from 'zod';

import { assertDisjoint } from './features/compose.js';
import { FEATURES, FEATURE_AUDIT_ACTIONS } from './features/index.js';
import { permissionSchema, roleSchema } from './rbac.js';

/**
 * HTTP contract of the auth, user, RBAC and audit endpoints. apps/api validates with these and
 * documents them in OpenAPI; apps/web (T-006) imports the same schemas, so the two cannot drift.
 */

/** Names of the cookies the api sets. Both are HttpOnly: scripts never see a token. */
export const ACCESS_COOKIE = 'wt_at';
export const REFRESH_COOKIE = 'wt_rt';
/** Header an authenticated browser must send on every POST, PUT, PATCH and DELETE. */
export const CSRF_HEADER = 'x-csrf-token';

/** Machine-readable `code` of an error response body, so the UI can branch without parsing text. */
export const AUTH_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'csrf_invalid',
  'origin_not_allowed',
  'invalid_credentials',
  'invalid_or_expired_link',
  'invalid_refresh_token',
  'rate_limited',
  'not_found',
  'conflict',
  'route_not_configured',
  'validation_failed',
  'invalid_transition',
  'merge_not_allowed',
  'ticket_not_open',
  'channel_no_outbound',
  'verification_failed',
  // Portal attachments (T-140): a file refused for its size, type, content or count.
  'attachment_rejected',
  // Object storage did not take or give a file (503).
  'storage_unavailable',
  // Too many uploads are being read at once (503 + Retry-After); try again shortly.
  'upload_busy',
  // Autonomy (T-112a): asking for stage 3 or above, which only the owner may decide (N3).
  'autonomy_stage_requires_owner',
  // Credential store (T-116a): a field that an environment variable sets cannot be saved.
  'credential_env_locked',
  // Knowledge base (T-107): a search that ran past its time limit and was stopped (503).
  'kb_search_timeout',
  // Shifts (T-111b): clock out refused because the handoff is missing or incomplete (AC-7). The body also
  // carries `noConfirmedHandoff` and `blockers` (see `handoffIncompleteSchema`).
  'handoff_incomplete',
  // Shifts (T-111): the handoff or the item is in a state that does not allow this (already confirmed, already acknowledged).
  'handoff_locked',
  // Investigation tools (T-203d): the system a button reaches is not connected here (503), or it did not answer (502/504).
  'tool_not_connected',
  'tool_failed',
  // Email reply (T-171 C-2): a recipient is on a domain the customer is not linked to; the body carries `domains`.
  'external_recipients',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  code: z.enum(AUTH_ERROR_CODES),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** Lower-cased and trimmed so one mailbox is one account. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const USER_STATUSES = ['active', 'disabled'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = (typeof USER_STATUSES)[number];

export const AUTH_METHODS = ['google', 'dev', 'magic_link', 'break_glass'] as const;
export const authMethodSchema = z.enum(AUTH_METHODS);
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  /** Set for clients only: the one organization they belong to. */
  orgId: z.uuid().nullable(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Returned by login, refresh and `GET /v1/auth/session`. Tokens travel in cookies, never here. */
export const sessionInfoSchema = z.object({
  user: sessionUserSchema,
  permissions: z.array(z.string()),
  sessionId: z.uuid(),
  authMethod: authMethodSchema,
  /** Send this value in the `x-csrf-token` header on every unsafe request. */
  csrfToken: z.string(),
  accessExpiresAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const authConfigSchema = z.object({
  google: z.object({
    mode: z.enum(['mock', 'live']),
    /** Navigate the browser here to start the Google sign-in. Null in mock mode. */
    startPath: z.string().nullable(),
  }),
  /** True only in mock mode outside production: `POST /v1/auth/dev-login` works. */
  devLoginEnabled: z.boolean(),
  magicLinkEnabled: z.boolean(),
  breakGlassEnabled: z.boolean(),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

export const devLoginRequestSchema = z.object({
  email: emailSchema,
  role: roleSchema.exclude(['system']).default('agent'),
  name: z.string().trim().min(1).max(200).optional(),
  /** Required when `role` is client. */
  orgId: z.uuid().optional(),
});
export type DevLoginRequest = z.infer<typeof devLoginRequestSchema>;

export const magicLinkRequestSchema = z.object({ email: emailSchema });
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/** Always this body, whether or not the address belongs to a client. */
export const magicLinkAcceptedSchema = z.object({ status: z.literal('accepted') });

export const magicLinkVerifySchema = z.object({ token: z.string().min(20).max(256) });
export type MagicLinkVerify = z.infer<typeof magicLinkVerifySchema>;

export const breakGlassLoginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});
export type BreakGlassLogin = z.infer<typeof breakGlassLoginSchema>;

export const deviceSchema = z.object({
  id: z.uuid(),
  authMethod: authMethodSchema,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;
export const deviceListSchema = z.object({ devices: z.array(deviceSchema) });

export const forceLogoutResultSchema = z.object({ revokedSessions: z.number().int().min(0) });

// --- users ---

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  orgId: z.uuid().nullable(),
  isBreakGlass: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;
export const userListSchema = z.object({ users: z.array(userSchema) });

export const createUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(200),
    role: roleSchema.exclude(['system']),
    /** Required for client, forbidden for staff. */
    orgId: z.uuid().optional(),
  })
  .refine((value) => (value.role === 'client') === (value.orgId !== undefined), {
    message: 'orgId is required for a client and not allowed for staff',
    path: ['orgId'],
  });
export type CreateUser = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    role: roleSchema.exclude(['system', 'client']).optional(),
    status: userStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to update' });
export type UpdateUser = z.infer<typeof updateUserSchema>;

export const userIdParamSchema = z.object({ id: z.uuid() });
export const sessionIdParamSchema = z.object({ id: z.uuid() });
export const roleParamSchema = z.object({ role: roleSchema });

// --- RBAC ---

export const rolePermissionsSchema = z.object({
  role: roleSchema,
  permissions: z.array(permissionSchema),
});
export const rolePermissionsListSchema = z.object({
  roles: z.array(rolePermissionsSchema),
  /** Every permission string that exists, with what it allows. */
  catalog: z.array(z.object({ key: permissionSchema, description: z.string() })),
});
export const setRolePermissionsSchema = z.object({
  permissions: z.array(permissionSchema).max(200),
});
export type SetRolePermissions = z.infer<typeof setRolePermissionsSchema>;

// --- audit log (PRD section 8.2) ---

/** Most rows one CSV export returns; narrow the dates for more. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

export const AUDIT_ACTOR_TYPES = ['user', 'system', 'ai', 'anonymous'] as const;
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  actorType: z.enum(AUDIT_ACTOR_TYPES),
  actorId: z.string().nullable(),
  action: z.string(),
  outcome: z.enum(AUDIT_OUTCOMES),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogQuerySchema = z.object({
  actorId: z.string().max(100).optional(),
  /** Who acted: a person, the system (jobs), the AI, or nobody signed in. */
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  action: z.string().max(100).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  targetType: z.string().max(100).optional(),
  targetId: z.string().max(100).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque value from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

/** Filters of the CSV export: the list's filters without paging, and a cap on the rows. */
export const auditLogExportQuerySchema = auditLogQuerySchema
  .omit({ limit: true, cursor: true })
  .extend({
    maxRows: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_EXPORT_MAX_ROWS)
      .default(AUDIT_EXPORT_MAX_ROWS),
  });
export type AuditLogExportQuery = z.infer<typeof auditLogExportQuerySchema>;

/** Columns of the CSV export, in order: no IP, no before/after, no free-form metadata. */
export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'actorType',
  'actorId',
  'action',
  'outcome',
  'targetType',
  'targetId',
  'requestId',
] as const;

export const auditLogPageSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});

/**
 * Audit action names of the core (Phase 0) features. A Phase 1 feature adds its own in
 * `features/<feature>.ts`, not here.
 */
export const CORE_AUDIT_ACTIONS = {
  piiRead: 'pii.read',
  authzDenied: 'authz.denied',
  csrfRejected: 'auth.csrf_rejected',
  loginGoogle: 'auth.login.google',
  loginGoogleFailed: 'auth.login.google_failed',
  loginDev: 'auth.login.dev',
  magicLinkRequested: 'auth.magic_link.requested',
  magicLinkRateLimited: 'auth.magic_link.rate_limited',
  magicLinkLogin: 'auth.login.magic_link',
  magicLinkFailed: 'auth.magic_link.failed',
  breakGlassLogin: 'auth.login.break_glass',
  breakGlassFailed: 'auth.break_glass.failed',
  breakGlassLocked: 'auth.break_glass.locked',
  breakGlassLockout: 'auth.break_glass.lockout',
  breakGlassUnlocked: 'auth.break_glass.unlocked',
  breakGlassRateLimited: 'auth.break_glass.rate_limited',
  breakGlassProvisioned: 'auth.break_glass.provisioned',
  refresh: 'auth.refresh',
  refreshReuse: 'auth.refresh.reuse_detected',
  logout: 'auth.logout',
  sessionRevoke: 'auth.session.revoke',
  forceLogout: 'auth.force_logout',
  userCreate: 'user.create',
  userUpdate: 'user.update',
  rolePermissionsSet: 'rbac.role_permissions.set',
  orgCreate: 'org.create',
  orgUpdate: 'org.update',
  orgDelete: 'org.delete',
  contactCreate: 'contact.create',
  contactUpdate: 'contact.update',
  contactDelete: 'contact.delete',
  queueCreate: 'queue.create',
  queueUpdate: 'queue.update',
  queueDelete: 'queue.delete',
  intentCreate: 'intent.create',
  intentUpdate: 'intent.update',
  intentDelete: 'intent.delete',
  slaPolicyCreate: 'sla_policy.create',
  slaPolicyUpdate: 'sla_policy.update',
  slaPolicyDelete: 'sla_policy.delete',
  calendarCreate: 'business_calendar.create',
  calendarUpdate: 'business_calendar.update',
  calendarDelete: 'business_calendar.delete',
  workflowSet: 'ticket_workflow.set',
  ticketCreate: 'ticket.create',
  ticketUpdate: 'ticket.update',
  ticketStatusChange: 'ticket.status_change',
  ticketAssign: 'ticket.assign',
  ticketMerge: 'ticket.merge',
  ticketReparent: 'ticket.reparent',
  ticketReply: 'ticket.reply',
  ticketNote: 'ticket.note',
  /** A developer picked a ticket up or let it go (T-137). */
  /** The automatic "we received your request" email of a ticket filed by hand was scheduled (T-136). */
  ticketConfirmationQueued: 'ticket.confirmation_queued',
  ticketDevPickup: 'ticket.dev_pickup',
  ticketDevRelease: 'ticket.dev_release',
  /** A ticket was linked to an incident or a deploy, or unlinked (T-137). */
  ticketReferenceAdd: 'ticket.reference_add',
  ticketReferenceRemove: 'ticket.reference_remove',
  portalTicketSubmit: 'portal.ticket.submit',
  portalLinkResend: 'portal.tracking_link.resend',
  portalLinkIssued: 'portal.tracking_link.issued',
  portalLinksRevoke: 'portal.tracking_links.revoke',
  portalVerificationFailed: 'portal.verification_failed',
  portalRateLimited: 'portal.rate_limited',
  portalAccessDenied: 'portal.access_denied',
  /** A portal upload was refused for its size, type or content (T-140). */
  portalAttachmentRejected: 'portal.attachment_rejected',
  /** A person downloaded a ticket attachment (T-140). */
  ticketAttachmentDownload: 'ticket.attachment_download',
  /** A person uploaded an image or file for a note, handoff, incident note or ticket. */
  uploadCreate: 'upload.create',
  /** A person opened an uploaded file. */
  uploadDownload: 'upload.download',
} as const;

/** Audit action names, so the UI and the tests do not retype strings: core plus every feature. */
export const AUDIT_ACTIONS = { ...CORE_AUDIT_ACTIONS, ...FEATURE_AUDIT_ACTIONS } as const;
assertDisjoint('AUDIT_ACTIONS', [
  CORE_AUDIT_ACTIONS,
  ...FEATURES.map((feature) => feature.auditActions),
]);
