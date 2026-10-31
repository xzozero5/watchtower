import { emailJobSchema, type EmailJob } from '@watchtower/shared';
import { UnrecoverableError, type Job } from 'bullmq';

import type { Mailer, OutboundMessage } from '../mailer.js';
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
    case 'portal_update':
    case 'portal_merged':
    case 'portal_link':
      return renderPortalEmail(job);
  }
}

/**
 * Processor for the `email` queue. A payload that fails validation can never succeed, so it ends
 * the job at once (UnrecoverableError) instead of burning retries; an SMTP failure throws normally
 * and BullMQ retries with backoff. The payload is not logged: it holds a one-time link.
 */
export function createEmailProcessor(mailer: Mailer) {
  return async (job: Job): Promise<{ sent: true }> => {
    const parsed = emailJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('email job payload is invalid');
    await mailer.send(renderEmail(parsed.data));
    return { sent: true };
  };
}
