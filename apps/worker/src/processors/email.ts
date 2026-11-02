import { emailJobSchema, sealedEnvelopeSchema, type EmailJob } from '@watchtower/shared';
import { openFields, outboxAad } from '@watchtower/shared/secret-box';
import { UnrecoverableError, type Job } from 'bullmq';

import type { Mailer, OutboundMessage } from '../mailer.js';
import { renderCsatEmail } from './csat-email.js';
import { escapeHtml } from './html.js';
import { renderPortalEmail } from './portal-email.js';

type MagicLinkJob = Extract<EmailJob, { kind: 'magic_link' }>;

function renderMagicLink(job: MagicLinkJob): OutboundMessage {
  const minutes = String(job.expiresInMinutes);
  const text = [
    'Sign in to Watchtower',
    '',
    `Open this link to sign in. It works once and expires in ${minutes} minutes:`,
    job.link,
    '',
    'If you did not ask for this email, you can ignore it.',
    '',
    '---',
    'เข้าสู่ระบบ Watchtower',
    '',
    `เปิดลิงก์นี้เพื่อเข้าสู่ระบบ ใช้ได้ครั้งเดียวและหมดอายุใน ${minutes} นาที`,
    'หากคุณไม่ได้ขออีเมลนี้ ไม่ต้องทำอะไร',
  ].join('\n');
  const link = escapeHtml(job.link);
  const html = [
    '<p>Open this link to sign in. It works once and expires in ' + minutes + ' minutes.</p>',
    `<p><a href="${link}">Sign in to Watchtower</a></p>`,
    '<p>If you did not ask for this email, you can ignore it.</p>',
    '<hr>',
    '<p>เปิดลิงก์เพื่อเข้าสู่ระบบ ใช้ได้ครั้งเดียวและหมดอายุใน ' + minutes + ' นาที</p>',
    '<p>หากคุณไม่ได้ขออีเมลนี้ ไม่ต้องทำอะไร</p>',
  ].join('\n');
  return { to: job.to, subject: 'Your Watchtower sign-in link', text, html };
}

/**
 * Turns an email job into a message. All wording lives here, in one place (TH and EN): the magic
 * link of T-004 and the client portal emails of T-007 (`portal-email.ts`).
 */
export function renderEmail(job: EmailJob): OutboundMessage {
  switch (job.kind) {
    case 'magic_link':
      return renderMagicLink(job);
    case 'portal_confirmation':
    case 'portal_reply_received':
    case 'portal_update':
    case 'portal_merged':
    case 'portal_link':
      return renderPortalEmail(job);
    case 'csat_survey':
      return renderCsatEmail(job);
  }
}

export interface EmailProcessorOptions {
  /** The outbox subkey (`deriveSubkey(APP_ENCRYPTION_KEY, KEY_LABELS.outboxSecret)`) that opens sealed links. */
  readonly sealKey: Buffer;
  /** Clock in epoch milliseconds. Tests pass a fixed one. */
  readonly now?: () => number;
}

export type EmailResult = { sent: true } | { sent: false; dropped: 'expired' };

/**
 * Processor for the `email` queue. The job holds the message parameters in the clear and its links
 * sealed (ADR-006): Redis, the failed-job history and logs only ever see ciphertext. The link is
 * opened here, in memory, just before SMTP.
 *
 *  - A job past its `notAfter` is dropped unsent and completes (so it leaves no failed job behind):
 *    a magic link past its lifetime opens nothing, and a stale tracking link should not be sent.
 *  - A payload that fails validation, or whose sealed part cannot be opened (wrong key, wrong job,
 *    tampering), can never succeed, so it ends the job at once (UnrecoverableError) instead of
 *    burning retries; an SMTP failure throws normally and BullMQ retries with backoff.
 *  - Nothing from the payload is logged or put in an error message.
 */
export function createEmailProcessor(mailer: Mailer, options: EmailProcessorOptions) {
  const now = options.now ?? Date.now;
  return async (job: Job): Promise<EmailResult> => {
    const envelope = sealedEnvelopeSchema.safeParse(job.data);
    if (!envelope.success) throw new UnrecoverableError('email job payload is invalid');
    const { secret, notAfter, ...clear } = envelope.data;
    if (notAfter !== undefined && now() >= notAfter) return { sent: false, dropped: 'expired' };

    let links: Record<string, string>;
    try {
      links = openFields(options.sealKey, secret, outboxAad(job.queueName, job.id ?? ''));
    } catch {
      throw new UnrecoverableError('email job secret cannot be opened');
    }
    const parsed = emailJobSchema.safeParse({ ...clear, ...links });
    if (!parsed.success) throw new UnrecoverableError('email job payload is invalid');
    await mailer.send(renderEmail(parsed.data));
    return { sent: true };
  };
}
