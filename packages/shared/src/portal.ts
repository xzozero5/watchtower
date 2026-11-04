import { z } from 'zod';

import { emailSchema } from './auth.js';
import type { TicketPriority } from './sla.js';
import type { TicketStatus } from './ticketing.js';

/**
 * HTTP contract of the public client portal (PRD section 4.9, T-007) and the rules both sides share:
 * the words a customer sees for a status, the form categories, the proof-of-work format.
 * apps/api validates and documents with these; apps/web imports the same schemas. Pure code: the
 * hashing itself happens in node:crypto (api) and WebCrypto (browser), see `powInput`.
 */

/** Header that carries the tracking token on every portal read and reply. Never a cookie. */
export const PORTAL_TOKEN_HEADER = 'x-portal-token';

/** The tracking link is `<APP_URL><portalTrackingPath(key)>#token=<token>`: the token stays in the fragment. */
export const PORTAL_TOKEN_FRAGMENT_KEY = 'token';
export function portalTrackingPath(ticketKey: string): string {
  return `/portal/tickets/${encodeURIComponent(ticketKey)}`;
}

export const PORTAL_LOCALES = ['en', 'th'] as const;
export type PortalLocale = (typeof PORTAL_LOCALES)[number];
export const portalLocaleSchema = z.enum(PORTAL_LOCALES);
export const DEFAULT_PORTAL_LOCALE: PortalLocale = 'en';

// --- the words a customer sees for a status (UI spec section 10) ---

export const CUSTOMER_STATUSES = [
  'received',
  'in_progress',
  'waiting_for_you',
  'resolved',
  'closed',
  'merged',
] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);

/**
 * What a customer sees for an internal status `[ASSUMED]` (UI spec section 10): `triage`, `open`
 * and `waiting_on_dev` all read "In progress", so moving between them is invisible and sends no
 * email. Used by the portal and by the client view in the workspace.
 */
export function customerStatus(status: TicketStatus): CustomerStatus {
  switch (status) {
    case 'new':
      return 'received';
    case 'triage':
    case 'open':
    case 'waiting_on_dev':
      return 'in_progress';
    case 'waiting_on_customer':
      return 'waiting_for_you';
    case 'resolved':
      return 'resolved';
    case 'closed':
      return 'closed';
    case 'merged':
      return 'merged';
  }
}

/** English fallback labels. The web app translates by `CustomerStatus` key (UI spec section 16). */
export const CUSTOMER_STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = {
  received: 'Received',
  in_progress: 'In progress',
  waiting_for_you: 'Waiting for your reply',
  resolved: 'Resolved',
  closed: 'Closed',
  merged: 'Merged',
};

// --- submit form ---

/**
 * Form categories. Each one is only a hint for the intent of the ticket: the api looks for an
 * active intent with the mapped key and files the ticket unclassified when the instance has none
 * `[ASSUMED]` (keys of the starter taxonomy, PRD section 3.1).
 */
export const PORTAL_CATEGORIES = [
  'outage',
  'api_error',
  'processing_failure',
  'webhook',
  'account_access',
  'billing',
  'configuration',
  'question',
  'other',
] as const;
export type PortalCategory = (typeof PORTAL_CATEGORIES)[number];
export const portalCategorySchema = z.enum(PORTAL_CATEGORIES);

export const PORTAL_CATEGORY_INTENT_HINT: Readonly<Record<PortalCategory, string>> = {
  outage: 'incident_inquiry',
  api_error: 'api_error',
  processing_failure: 'processing_failure',
  webhook: 'webhook_not_received',
  account_access: 'account_access',
  billing: 'billing_report',
  configuration: 'workspace_config',
  question: 'feature_question',
  other: 'other',
};

/** Plain-word urgency of the form ("Everything is down", "Something is broken", "A question"). */
export const PORTAL_URGENCIES = ['everything_down', 'something_broken', 'question'] as const;
export type PortalUrgency = (typeof PORTAL_URGENCIES)[number];
export const portalUrgencySchema = z.enum(PORTAL_URGENCIES);

/** Priority an urgency asks for `[ASSUMED]`; the api caps it for submitters it cannot place in an organization. */
export const PORTAL_URGENCY_PRIORITY: Readonly<Record<PortalUrgency, TicketPriority>> = {
  everything_down: 'P1',
  something_broken: 'P2',
  question: 'P3',
};

export const PORTAL_MAX_DESCRIPTION = 10_000;
export const PORTAL_MAX_REQUEST_IDS = 10;

// --- human verification (ADR-007) ---

/**
 * What the page must solve before it submits. `provider` leaves room for a hosted provider later
 * (a new variant here and a new class behind `HumanVerificationProvider` in the api).
 */
export const humanChallengeSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('pow-sha256'),
    /** Opaque, signed by the server. Send it back unchanged with the nonce. */
    challenge: z.string(),
    /**
     * Find a `nonce` (decimal string) so that SHA-256 of the UTF-8 text `<challenge>:<nonce>` starts
     * with at least this many zero bits. See `powInput` and `leadingZeroBits`.
     */
    difficultyBits: z.number().int().min(1).max(32),
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** Submitting sooner than this after `issuedAt` is refused: ask for the challenge when the form opens. */
    minFillSeconds: z.number().int().min(0),
  }),
]);
export type HumanChallenge = z.infer<typeof humanChallengeSchema>;

export const humanProofSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('pow-sha256'),
    challenge: z.string().min(1).max(400),
    nonce: z.string().regex(/^[0-9]{1,20}$/, 'expected a decimal number'),
  }),
]);
export type HumanProof = z.infer<typeof humanProofSchema>;

/**
 * Header that carries the proof of work of a submit with files, as base64url of the JSON of the
 * `verification` field (T-154). The api checks it before it reserves an upload slot, so a script that
 * cannot do the proof never holds memory; the form still sends the same proof in `payload`.
 */
export const PORTAL_PROOF_HEADER = 'x-portal-proof';

/** The value for `PORTAL_PROOF_HEADER`. */
export function encodePortalProof(proof: HumanProof): string {
  return btoa(JSON.stringify(proof)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The proof in a header value, or null when it is not one. Never throws. */
export function decodePortalProof(value: string): HumanProof | null {
  if (value.length === 0 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const parsed = humanProofSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The exact text that is hashed for a proof-of-work solution. */
export function powInput(challenge: string, nonce: string): string {
  return `${challenge}:${nonce}`;
}

/** Number of leading zero bits of a hash. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

// --- attachments (R-9.1, R-9.3, T-140) ---

/** Files per submission or reply. `[ASSUMED]` limits; the api enforces them, the page checks first for a faster answer. */
export const PORTAL_ATTACHMENT_MAX_FILES = 5;
export const PORTAL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PORTAL_ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
/** Longest file name kept for display; the name is never part of the storage key. */
export const PORTAL_ATTACHMENT_MAX_NAME = 120;

/** Multipart field names of a submission or reply that carries files. */
export const PORTAL_MULTIPART_PAYLOAD_FIELD = 'payload';
export const PORTAL_MULTIPART_FILES_FIELD = 'files';

/**
 * What a customer may attach, by extension. Images and a PDF are the usual screenshots and
 * statements; txt/csv/log are for an error log or an export. No SVG or HTML (script in a file a
 * browser may render), no archives or office files (opaque to the check). The api decides by the
 * file's own bytes, not by this table: the extension has to agree with what the bytes are.
 */
export const PORTAL_ATTACHMENT_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'txt',
  'csv',
  'log',
] as const;
export type PortalAttachmentExtension = (typeof PORTAL_ATTACHMENT_EXTENSIONS)[number];

/** Value for `<input accept>`. */
export const PORTAL_ATTACHMENT_ACCEPT = PORTAL_ATTACHMENT_EXTENSIONS.map((ext) => `.${ext}`).join(
  ',',
);

/** Lower-case extension of a file name when it is an allowed one, else null. */
export function portalAttachmentExtension(fileName: string): PortalAttachmentExtension | null {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (PORTAL_ATTACHMENT_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as PortalAttachmentExtension)
    : null;
}

export type PortalAttachmentProblem =
  'too_many' | 'empty' | 'too_large' | 'type_not_allowed' | 'total_too_large';

/** The checks the page can make without reading the file; the api repeats them and also checks the bytes. */
export function checkPortalAttachments(
  files: readonly { readonly name: string; readonly size: number }[],
): { readonly index: number | null; readonly problem: PortalAttachmentProblem } | null {
  if (files.length > PORTAL_ATTACHMENT_MAX_FILES) return { index: null, problem: 'too_many' };
  let total = 0;
  for (const [index, file] of files.entries()) {
    if (file.size === 0) return { index, problem: 'empty' };
    if (file.size > PORTAL_ATTACHMENT_MAX_BYTES) return { index, problem: 'too_large' };
    if (portalAttachmentExtension(file.name) === null)
      return { index, problem: 'type_not_allowed' };
    total += file.size;
  }
  return total > PORTAL_ATTACHMENT_MAX_TOTAL_BYTES
    ? { index: null, problem: 'total_too_large' }
    : null;
}

/** An attachment as the customer sees it on the tracking page: name and size, no link. */
export const portalAttachmentSchema = z.object({
  name: z.string(),
  size: z.number().int().min(0),
});
export type PortalAttachment = z.infer<typeof portalAttachmentSchema>;

// --- endpoints ---

const requestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:/@=+-]+$/, 'expected letters, digits and . _ : / @ = + -');

export const portalSubmitSchema = z.strictObject({
  email: emailSchema,
  name: z.string().trim().min(1).max(200),
  /**
   * The organization as the customer writes it. An allow-listed email domain decides the real
   * organization; this text is kept for triage when it does not.
   */
  organization: z.string().trim().min(1).max(200).optional(),
  category: portalCategorySchema,
  urgency: portalUrgencySchema.optional(),
  subject: z.string().trim().min(1).max(150).optional(),
  description: z.string().trim().min(1).max(PORTAL_MAX_DESCRIPTION),
  /** Affected session or API request ids, one per entry. */
  affectedRequestIds: z.array(requestIdSchema).max(PORTAL_MAX_REQUEST_IDS).optional(),
  locale: portalLocaleSchema.optional(),
  /** Honeypot. Hidden from people; a bot that fills it is refused. Send an empty string or leave it out. */
  website: z.string().max(500).optional(),
  verification: humanProofSchema,
});
export type PortalSubmit = z.infer<typeof portalSubmitSchema>;

/**
 * Text fields of a multipart request: the JSON of the normal body in one `payload` field, the files
 * in `files`. The api parses `payload` with the schema of the endpoint (`portalSubmitSchema`,
 * `portalReplySchema`), so there is one definition of each form.
 */
export const portalMultipartSchema = z.strictObject({
  payload: z.string().min(2).max(200_000),
});
export type PortalMultipart = z.infer<typeof portalMultipartSchema>;

/** The body of `POST /portal/tickets`: JSON, or the multipart envelope when the request has files. */
export const portalSubmitRequestSchema = z.union([portalSubmitSchema, portalMultipartSchema]);
export type PortalSubmitRequest = z.infer<typeof portalSubmitRequestSchema>;

export const portalSubmittedSchema = z.object({
  ticketKey: z.string(),
  /** `a***@example.com`. The tracking link goes to this address only; it is never in this response. */
  maskedEmail: z.string(),
  status: customerStatusSchema,
  /** First response target from the SLA policy; null when no policy applies. */
  expectedFirstResponseAt: z.iso.datetime().nullable(),
});
export type PortalSubmitted = z.infer<typeof portalSubmittedSchema>;

export const portalTicketKeyParamSchema = z.object({
  key: z.string().trim().min(3).max(32),
});

export const portalAgentSchema = z.object({
  /** First name only (UI spec Q6); never a surname, an email or a role. */
  displayName: z.string().nullable(),
});

export const portalTimelineEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    id: z.uuid(),
    /** `customer`: written on the portal or by email; `support`: a reply from the team. */
    from: z.enum(['customer', 'support']),
    /** First name of the staff member for `support`; null for `customer`. */
    authorName: z.string().nullable(),
    body: z.string(),
    /** Files attached to the message (name and size only; the team downloads them, the customer already has them). */
    attachments: z.array(portalAttachmentSchema).optional(),
    createdAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal('status'),
    id: z.uuid(),
    status: customerStatusSchema,
    label: z.string(),
    /** Key of the primary ticket when `status` is `merged`. */
    mergedIntoKey: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
]);
export type PortalTimelineEntry = z.infer<typeof portalTimelineEntrySchema>;

export const portalTicketViewSchema = z.object({
  key: z.string(),
  subject: z.string(),
  status: customerStatusSchema,
  /** English label; translate by `status` in the UI. */
  statusLabel: z.string(),
  mergedIntoKey: z.string().nullable(),
  maskedEmail: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  /** Until the team has answered: when the SLA says that should happen. */
  expectedFirstResponseAt: z.iso.datetime().nullable(),
  /** False once the ticket is closed or merged, or was resolved too long ago to reopen. */
  canReply: z.boolean(),
  /** The oldest entries first. At most `PORTAL_TIMELINE_LIMIT`; `truncated` says the start was cut. */
  timeline: z.array(portalTimelineEntrySchema),
  truncated: z.boolean(),
  /** When the token in use stops working. The link in the next email extends it. */
  accessExpiresAt: z.iso.datetime(),
});
export type PortalTicketView = z.infer<typeof portalTicketViewSchema>;
export const PORTAL_TIMELINE_LIMIT = 200;

export const portalReplySchema = z.strictObject({
  body: z.string().trim().min(1).max(PORTAL_MAX_DESCRIPTION),
});
export type PortalReply = z.infer<typeof portalReplySchema>;

/** The body of `POST /portal/tickets/:key/replies`: JSON, or the multipart envelope when the request has files. */
export const portalReplyRequestSchema = z.union([portalReplySchema, portalMultipartSchema]);
export type PortalReplyRequest = z.infer<typeof portalReplyRequestSchema>;

export const portalReplyResultSchema = z.object({
  message: z.object({
    id: z.uuid(),
    from: z.literal('customer'),
    authorName: z.null(),
    body: z.string(),
    attachments: z.array(portalAttachmentSchema).optional(),
    createdAt: z.iso.datetime(),
  }),
  status: customerStatusSchema,
  statusLabel: z.string(),
});
export type PortalReplyResult = z.infer<typeof portalReplyResultSchema>;

export const portalResendSchema = z.strictObject({
  ticketKey: z.string().trim().min(3).max(32),
  email: emailSchema,
});
export type PortalResend = z.infer<typeof portalResendSchema>;

/** The same answer whether or not the ticket and address exist. */
export const portalAcceptedSchema = z.object({ status: z.literal('accepted') });

export const portalRevokeResultSchema = z.object({ revoked: z.number().int().min(0) });

/** `a***@example.com`: the first character of the local part and the whole domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  const codePoint = email.codePointAt(0);
  const first = codePoint === undefined ? '' : String.fromCodePoint(codePoint);
  return `${first}***${email.slice(at)}`;
}
