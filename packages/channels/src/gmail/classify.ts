import { z } from 'zod';

import { parseAddressList, parseStructuredValue, type HeaderBag } from './mime.js';

/**
 * Rule-based "is this a person?" check (R-2.6, R-2.7). Pure and header-driven so it also works as
 * the fallback when the LLM classifier is down (ADR-009 step 4).
 *
 * Two outcomes matter downstream:
 * - `auto_reply`: bounce, out-of-office, any RFC 3834 automatic response, `Precedence: bulk`.
 *   Never creates a ticket and never gets an auto-ack (loop prevention, R-2.6).
 * - `noise`: newsletters, mailing lists, no-reply notifications, Gmail promotion / social /
 *   spam categories. No ticket, shown in "Other mail" (R-2.7) where a person can convert it.
 *
 * A subject-line pattern alone never changes the outcome: "Re: automatic reply system is broken"
 * from a real customer must still become a ticket. It only sets `suspect`.
 */

export const AUTOMATED_DISPOSITIONS = ['human', 'auto_reply', 'noise'] as const;

export const AUTOMATED_SUBTYPES = [
  'bounce',
  'out_of_office',
  'auto_submitted',
  'precedence_bulk',
  'mailing_list',
  'no_reply_sender',
  'gmail_category',
  'none',
] as const;

export const automatedVerdictSchema = z.object({
  disposition: z.enum(AUTOMATED_DISPOSITIONS),
  subtype: z.enum(AUTOMATED_SUBTYPES),
  /** Header / structure evidence, for the audit trail. */
  signals: z.array(z.string()),
  /** The mail looks automated only from its subject: surface to a human, do not drop. */
  suspect: z.boolean(),
  /** Same as `disposition !== 'human'`: never send an auto-ack, never create a ticket. */
  suppressAutoAck: z.boolean(),
  dsn: z
    .object({
      action: z.string().nullable(),
      status: z.string().nullable(),
      finalRecipient: z.string().nullable(),
    })
    .nullable(),
});

export type AutomatedVerdict = z.infer<typeof automatedVerdictSchema>;

export interface ClassifyInput {
  readonly headers: HeaderBag;
  /** Root `Content-Type` main value, for example `multipart/report`. */
  readonly rootContentType: string;
  readonly rootContentTypeParams: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly deliveryStatusParts?: readonly string[];
  /** Gmail label ids, when known (`CATEGORY_PROMOTIONS`, `SPAM`, ...). */
  readonly labelIds?: readonly string[];
}

const NOISE_LABELS = new Set([
  'SPAM',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_FORUMS',
  'CATEGORY_UPDATES',
]);

const SUBJECT_AUTOREPLY_PATTERNS: readonly RegExp[] = [
  /^\s*(?:auto(?:matic)?[ -]?(?:reply|response)|autoreply|auto:|out of (?:the )?office|away from (?:my )?(?:desk|office)|undeliverable|delivery (?:status notification|failure)|mail delivery (?:failed|failure|subsystem)|returned mail|failure notice)/i,
  /(?:ตอบกลับอัตโนมัติ|ข้อความอัตโนมัติ|ไม่อยู่ที่ออฟฟิศ|อยู่นอกสำนักงาน|ลาพักร้อน)/,
];

const NO_REPLY_LOCAL_PART =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer-daemon|postmaster|bounce[s]?(?:[-_.+].*)?)$/i;

function firstToken(value: string | undefined): string {
  return (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function parseDsn(parts: readonly string[]): AutomatedVerdict['dsn'] {
  // message/delivery-status: a per-message block, then one block per recipient (RFC 3464).
  for (const part of parts) {
    const field = (name: string): string | null => {
      const match = new RegExp(`^${name}:[ \\t]*(.+)$`, 'im').exec(part);
      return match?.[1]?.trim() ?? null;
    };
    const finalRecipient = field('Final-Recipient');
    const action = field('Action');
    const status = field('Status');
    if (finalRecipient !== null || action !== null || status !== null) {
      return {
        action: action?.toLowerCase() ?? null,
        status,
        // "rfc822; user@example.com" -> "user@example.com"
        finalRecipient: finalRecipient?.replace(/^[^;]*;\s*/, '') ?? null,
      };
    }
  }
  return null;
}

export function classifyAutomated(input: ClassifyInput): AutomatedVerdict {
  const { headers } = input;
  const signals: string[] = [];
  const result = (
    disposition: AutomatedVerdict['disposition'],
    subtype: AutomatedVerdict['subtype'],
    suspect = false,
    dsn: AutomatedVerdict['dsn'] = null,
  ): AutomatedVerdict => ({
    disposition,
    subtype,
    signals,
    suspect,
    suppressAutoAck: disposition !== 'human',
    dsn,
  });

  // 1. Delivery status notification (RFC 3464 / RFC 6522): multipart/report; report-type=delivery-status.
  const reportType = (input.rootContentTypeParams['report-type'] ?? '').toLowerCase();
  const fromAddress = parseAddressList(headers.get('from'))[0]?.address ?? '';
  const fromLocal = fromAddress.split('@')[0] ?? '';
  const returnPath = headers.get('return-path')?.trim();
  const isDsnStructure =
    input.rootContentType === 'multipart/report' &&
    (reportType === 'delivery-status' || reportType === '');
  if (isDsnStructure) signals.push('content_type:multipart/report');
  if (headers.has('x-failed-recipients')) signals.push('header:x-failed-recipients');
  if (/^(?:mailer-daemon|postmaster)$/i.test(fromLocal)) signals.push('sender:mailer-daemon');
  if (
    isDsnStructure ||
    headers.has('x-failed-recipients') ||
    /^(?:mailer-daemon|postmaster)$/i.test(fromLocal)
  ) {
    return result('auto_reply', 'bounce', false, parseDsn(input.deliveryStatusParts ?? []));
  }
  if (input.rootContentType === 'multipart/report') {
    // Read receipts (MDN, RFC 8098) and other machine reports are never conversation.
    signals.push(`content_type:multipart/report;report-type=${reportType}`);
    return result('auto_reply', 'auto_submitted');
  }
  // A null reverse-path is how mail systems mark bounces (RFC 5321 section 4.5.5).
  if (returnPath === '<>') {
    signals.push('header:return-path-null');
    return result('auto_reply', 'bounce');
  }

  // 2. Out-of-office / autoresponders by header.
  const autoSubmitted = firstToken(headers.get('auto-submitted'));
  const outOfOfficeHeaders = [
    'x-autoreply',
    'x-autorespond',
    'x-auto-response',
    'x-vacation',
    'x-vacationreply',
  ].filter((name) => headers.has(name));
  const precedence = firstToken(headers.get('precedence'));
  if (outOfOfficeHeaders.length > 0) {
    for (const name of outOfOfficeHeaders) signals.push(`header:${name}`);
    return result('auto_reply', 'out_of_office');
  }
  if (precedence === 'auto_reply' || precedence === 'auto-reply') {
    signals.push('header:precedence=auto_reply');
    return result('auto_reply', 'out_of_office');
  }
  // RFC 3834 section 5: any value other than "no" marks an automatic message.
  if (autoSubmitted !== '' && autoSubmitted !== 'no') {
    signals.push(`header:auto-submitted=${autoSubmitted}`);
    return result(
      'auto_reply',
      autoSubmitted === 'auto-replied' ? 'out_of_office' : 'auto_submitted',
    );
  }

  // 3. Mailing lists and newsletters are noise; `Precedence: bulk|junk` is an auto-reply per R-2.6.
  const hasListHeaders =
    headers.has('list-unsubscribe') || headers.has('list-id') || headers.has('list-post');
  if (hasListHeaders) {
    for (const name of ['list-unsubscribe', 'list-id', 'list-post']) {
      if (headers.has(name)) signals.push(`header:${name}`);
    }
    if (precedence !== '') signals.push(`header:precedence=${precedence}`);
    return result('noise', 'mailing_list');
  }
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'list') {
    signals.push(`header:precedence=${precedence}`);
    return result('auto_reply', 'precedence_bulk');
  }
  if (headers.has('feedback-id')) {
    signals.push('header:feedback-id');
    return result('noise', 'mailing_list');
  }

  // 4. Gmail's own categorisation.
  const noiseLabels = (input.labelIds ?? []).filter((label) => NOISE_LABELS.has(label));
  if (noiseLabels.length > 0) {
    for (const label of noiseLabels) signals.push(`label:${label}`);
    return result('noise', 'gmail_category');
  }

  // 5. System sender addresses.
  if (NO_REPLY_LOCAL_PART.test(fromLocal)) {
    signals.push('sender:no-reply');
    return result('noise', 'no_reply_sender');
  }

  // 6. Subject-only evidence never decides.
  if (SUBJECT_AUTOREPLY_PATTERNS.some((pattern) => pattern.test(input.subject))) {
    signals.push('subject:autoreply-pattern');
    return result('human', 'none', true);
  }
  return result('human', 'none');
}

/** `Content-Type` header text -> `{ main, params }`, for callers that only have the header. */
export function rootContentTypeOf(headers: HeaderBag): {
  readonly main: string;
  readonly params: Readonly<Record<string, string>>;
} {
  return parseStructuredValue(headers.get('content-type') ?? 'text/plain');
}
