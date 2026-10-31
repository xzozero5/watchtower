import type { CustomerStatus, EmailJob, PortalLocale } from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from './html.js';

type PortalJob = Extract<
  EmailJob,
  { kind: 'portal_confirmation' | 'portal_update' | 'portal_merged' | 'portal_link' }
>;

/**
 * The words of the client portal emails, in English and Thai (UI spec section 16, wording
 * `[ASSUMED]`; a deployment can override customer-facing copy). One language per email, chosen by
 * the contact's preference. Deliberately plain: text and a little HTML, no images, no tracking
 * pixels, no external resources. The tracking link is the only link.
 */

const STATUS_LABEL: Readonly<Record<PortalLocale, Readonly<Record<CustomerStatus, string>>>> = {
  en: {
    received: 'Received',
    in_progress: 'In progress',
    waiting_for_you: 'Waiting for your reply',
    resolved: 'Resolved',
    closed: 'Closed',
    merged: 'Merged',
  },
  th: {
    received: 'ได้รับแล้ว',
    in_progress: 'กำลังดำเนินการ',
    waiting_for_you: 'รอคำตอบจากคุณ',
    resolved: 'แก้ไขแล้ว',
    closed: 'ปิดแล้ว',
    merged: 'รวมกับคำขออื่นแล้ว',
  },
};

interface Copy {
  readonly subject: string;
  /** Paragraphs before the link. */
  readonly lead: readonly string[];
  readonly linkText: string;
  /** Paragraphs after the link. */
  readonly tail: readonly string[];
}

const PRIVACY_EN =
  'This link is personal to you: anyone who has it can read and answer this request.';
const PRIVACY_TH = 'ลิงก์นี้เป็นของคุณเท่านั้น ผู้ที่มีลิงก์สามารถอ่านและตอบคำขอนี้ได้';

function formatDue(iso: string, locale: PortalLocale): string {
  const formatter = new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-gregory' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  return `${formatter.format(new Date(iso))} UTC`;
}

function english(job: PortalJob): Copy {
  const key = job.ticketKey;
  switch (job.kind) {
    case 'portal_confirmation':
      return {
        subject: `We received your request ${key}`,
        lead: [
          `We received your request ${key}: ${job.subject}`,
          ...(job.expectedFirstResponseAt === null
            ? []
            : [`We aim to reply by ${formatDue(job.expectedFirstResponseAt, 'en')}.`]),
          'Follow the progress and reply from this page:',
        ],
        linkText: 'Open your request',
        tail: [PRIVACY_EN],
      };
    case 'portal_update': {
      const label = STATUS_LABEL.en[job.status];
      if (job.reason === 'staff_reply') {
        const who =
          job.agentName === null ? 'Our support team' : `${job.agentName} from our support team`;
        return {
          subject: `New reply on ${key}`,
          lead: [`${who} replied to your request ${key}: ${job.subject}`, `Status: ${label}.`],
          linkText: 'Read the reply',
          tail: [PRIVACY_EN],
        };
      }
      return {
        subject: `${key} is now: ${label}`,
        lead: [
          `The status of your request ${key} changed to "${label}".`,
          ...(job.status === 'waiting_for_you' ? ['We need your reply to continue.'] : []),
          ...(job.status === 'resolved'
            ? [
                'If it is not solved, reply from the page below within 7 days and we will reopen it.',
              ]
            : []),
        ],
        linkText: 'Open your request',
        tail: [PRIVACY_EN],
      };
    }
    case 'portal_merged':
      return {
        subject: `${key} was merged into ${job.intoKey}`,
        lead: [
          `We combined your request ${key}: ${job.subject} with ${job.intoKey}, because they are about the same thing.`,
          `We continue the work on ${job.intoKey}. This page keeps showing ${key} and where it went:`,
        ],
        linkText: 'Open your request',
        tail: [PRIVACY_EN],
      };
    case 'portal_link':
      return {
        subject: `Your link for ${key}`,
        lead: [`Here is a new link for your request ${key}: ${job.subject}`],
        linkText: 'Open your request',
        tail: [PRIVACY_EN, 'If you did not ask for this email, you can ignore it.'],
      };
  }
}

function thai(job: PortalJob): Copy {
  const key = job.ticketKey;
  switch (job.kind) {
    case 'portal_confirmation':
      return {
        subject: `เราได้รับคำขอ ${key} แล้ว`,
        lead: [
          `เราได้รับคำขอ ${key}: ${job.subject}`,
          ...(job.expectedFirstResponseAt === null
            ? []
            : [`เราตั้งเป้าตอบกลับภายใน ${formatDue(job.expectedFirstResponseAt, 'th')}`]),
          'ติดตามสถานะและตอบกลับได้ที่หน้านี้:',
        ],
        linkText: 'เปิดคำขอของคุณ',
        tail: [PRIVACY_TH],
      };
    case 'portal_update': {
      const label = STATUS_LABEL.th[job.status];
      if (job.reason === 'staff_reply') {
        const who = job.agentName === null ? 'ทีมซัพพอร์ต' : `${job.agentName} จากทีมซัพพอร์ต`;
        return {
          subject: `มีการตอบกลับใหม่ใน ${key}`,
          lead: [`${who}ตอบกลับคำขอ ${key} ของคุณ: ${job.subject}`, `สถานะ: ${label}`],
          linkText: 'อ่านคำตอบ',
          tail: [PRIVACY_TH],
        };
      }
      return {
        subject: `${key} สถานะ: ${label}`,
        lead: [
          `สถานะของคำขอ ${key} เปลี่ยนเป็น "${label}"`,
          ...(job.status === 'waiting_for_you' ? ['เราต้องการคำตอบจากคุณเพื่อดำเนินการต่อ'] : []),
          ...(job.status === 'resolved'
            ? ['หากยังไม่หาย ตอบกลับที่หน้านี้ภายใน 7 วัน เราจะเปิดเรื่องใหม่ให้']
            : []),
        ],
        linkText: 'เปิดคำขอของคุณ',
        tail: [PRIVACY_TH],
      };
    }
    case 'portal_merged':
      return {
        subject: `${key} ถูกรวมเข้ากับ ${job.intoKey}`,
        lead: [
          `เรารวมคำขอ ${key}: ${job.subject} เข้ากับ ${job.intoKey} เพราะเป็นเรื่องเดียวกัน`,
          `เราดำเนินการต่อที่ ${job.intoKey} หน้านี้ยังแสดง ${key} และปลายทางที่ถูกรวม:`,
        ],
        linkText: 'เปิดคำขอของคุณ',
        tail: [PRIVACY_TH],
      };
    case 'portal_link':
      return {
        subject: `ลิงก์ใหม่สำหรับ ${key}`,
        lead: [`ลิงก์ใหม่สำหรับคำขอ ${key}: ${job.subject}`],
        linkText: 'เปิดคำขอของคุณ',
        tail: [PRIVACY_TH, 'หากคุณไม่ได้ขออีเมลนี้ ไม่ต้องทำอะไร'],
      };
  }
}

/** Renders one portal email in the language of the job. */
export function renderPortalEmail(job: PortalJob): OutboundMessage {
  const copy = job.locale === 'th' ? thai(job) : english(job);
  const text = [...copy.lead, job.trackingUrl, ...copy.tail].join('\n\n');
  const html = [
    ...copy.lead.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(job.trackingUrl)}">${escapeHtml(copy.linkText)}</a></p>`,
    ...copy.tail.map((line) => `<p>${escapeHtml(line)}</p>`),
  ].join('\n');
  return { to: job.to, subject: copy.subject, text, html };
}
