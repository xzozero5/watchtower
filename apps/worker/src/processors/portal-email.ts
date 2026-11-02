import type {
  CustomerStatus,
  EmailJob,
  PortalCategory,
  PortalLocale,
  PortalUrgency,
} from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from './html.js';

type PortalJob = Extract<
  EmailJob,
  {
    kind:
      | 'portal_confirmation'
      | 'portal_reply_received'
      | 'portal_update'
      | 'portal_merged'
      | 'portal_link';
  }
>;

/**
 * The words of the client portal emails, in English and Thai (UI spec section 16, wording
 * `[ASSUMED]`; a deployment can override customer-facing copy). One language per email, chosen by
 * the contact's preference. Deliberately plain: text and a little HTML, no images, no tracking
 * pixels, no external resources. The tracking link is the only link.
 *
 * The confirmation never repeats text the submitter typed (C-11, ADR-007): its recap lists fixed
 * choices from the form only (topic, urgency), never the subject or the description.
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

const CATEGORY_LABEL: Readonly<Record<PortalLocale, Readonly<Record<PortalCategory, string>>>> = {
  en: {
    outage: 'Service outage',
    api_error: 'API error',
    processing_failure: 'Processing failure',
    webhook: 'Webhook not received',
    account_access: 'Account access',
    billing: 'Billing',
    configuration: 'Configuration',
    question: 'Question',
    other: 'Other',
  },
  th: {
    outage: 'บริการล่ม',
    api_error: 'API ผิดพลาด',
    processing_failure: 'การประมวลผลล้มเหลว',
    webhook: 'ไม่ได้รับ webhook',
    account_access: 'เข้าใช้บัญชีไม่ได้',
    billing: 'การเรียกเก็บเงิน',
    configuration: 'การตั้งค่า',
    question: 'คำถาม',
    other: 'อื่น ๆ',
  },
};

const URGENCY_LABEL: Readonly<Record<PortalLocale, Readonly<Record<PortalUrgency, string>>>> = {
  en: {
    everything_down: 'Everything is down',
    something_broken: 'Something is broken',
    question: 'A question',
  },
  th: {
    everything_down: 'ใช้งานไม่ได้ทั้งหมด',
    something_broken: 'บางอย่างใช้งานไม่ได้',
    question: 'คำถามทั่วไป',
  },
};

interface Section {
  readonly heading: string;
  readonly items: readonly string[];
}

interface Copy {
  readonly subject: string;
  /** Paragraphs before the link. */
  readonly lead: readonly string[];
  /** What the customer chose on the form (fixed choices only), as a short list. */
  readonly recap?: Section;
  /** Numbered "what happens next" steps. */
  readonly steps?: Section;
  readonly linkText: string;
  /** Paragraphs after the link. */
  readonly tail: readonly string[];
}

const PRIVACY_EN =
  'This link is personal to you: anyone who has it can read and answer this request.';
const PRIVACY_TH = 'ลิงก์นี้เป็นของคุณเท่านั้น ผู้ที่มีลิงก์สามารถอ่านและตอบคำขอนี้ได้';
const NOT_YOU_EN =
  'You are receiving this because someone used this address on our support form. If that was not you, you can ignore this email.';
const NOT_YOU_TH =
  'คุณได้รับอีเมลนี้เพราะมีผู้ใช้ที่อยู่อีเมลนี้กรอกแบบฟอร์มซัพพอร์ต หากไม่ใช่คุณ ไม่ต้องทำอะไร';

function formatDue(iso: string, locale: PortalLocale): string {
  const formatter = new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-gregory' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  return `${formatter.format(new Date(iso))} UTC`;
}

function recap(
  locale: PortalLocale,
  category: PortalCategory | null | undefined,
  urgency: PortalUrgency | null | undefined,
): Section | undefined {
  const th = locale === 'th';
  const items = [
    ...(category == null ? [] : [`${th ? 'หมวด' : 'Topic'}: ${CATEGORY_LABEL[locale][category]}`]),
    ...(urgency == null
      ? []
      : [
          `${th ? 'ความเร่งด่วนที่คุณเลือก' : 'Urgency you chose'}: ${URGENCY_LABEL[locale][urgency]}`,
        ]),
  ];
  if (items.length === 0) return undefined;
  return { heading: th ? 'สรุปคำขอของคุณ' : 'Your request', items };
}

function english(job: PortalJob): Copy {
  const key = job.ticketKey;
  switch (job.kind) {
    case 'portal_confirmation':
      return {
        subject: `We received your request ${key}`,
        lead: [
          `Thank you for contacting us. Your request has the reference ${key}; please quote it if you write to us again.`,
          job.expectedFirstResponseAt === null
            ? 'Our support team will review it and reply as soon as possible.'
            : `We aim to send a first reply by ${formatDue(job.expectedFirstResponseAt, 'en')}. This target counts support business hours, so a request sent outside them may be answered on the next working day.`,
        ],
        recap: recap('en', job.category, job.urgency),
        steps: {
          heading: 'What happens next',
          items: [
            'We read your request and, if we need more details, ask you for them.',
            'We investigate and keep the status on your request page up to date.',
            'We reply by email and on your request page; you can answer from that page at any time.',
          ],
        },
        linkText: 'Track your request',
        tail: [PRIVACY_EN, NOT_YOU_EN],
      };
    case 'portal_reply_received':
      return {
        subject: `We received your reply on ${key}`,
        lead: [
          `We received your reply on request ${key}. Our support team will read it and get back to you.`,
          'There is nothing else you need to do now.',
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
        lead: [`Here is a new link for your request ${key}.`],
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
          `ขอบคุณที่ติดต่อเรา คำขอของคุณมีหมายเลขอ้างอิง ${key} โปรดระบุหมายเลขนี้ทุกครั้งที่ติดต่อเราอีก`,
          job.expectedFirstResponseAt === null
            ? 'ทีมซัพพอร์ตจะตรวจสอบและตอบกลับโดยเร็วที่สุด'
            : `เราตั้งเป้าตอบกลับครั้งแรกภายใน ${formatDue(job.expectedFirstResponseAt, 'th')} เป้าหมายนี้นับเฉพาะเวลาทำการของทีมซัพพอร์ต หากส่งคำขอนอกเวลาทำการ อาจได้รับคำตอบในวันทำการถัดไป`,
        ],
        recap: recap('th', job.category, job.urgency),
        steps: {
          heading: 'ขั้นตอนต่อไป',
          items: [
            'เราอ่านคำขอของคุณ และสอบถามรายละเอียดเพิ่มเติมหากจำเป็น',
            'เราตรวจสอบปัญหาและอัปเดตสถานะที่หน้าคำขอของคุณ',
            'เราตอบกลับทางอีเมลและที่หน้าคำขอ คุณตอบกลับจากหน้านั้นได้ทุกเมื่อ',
          ],
        },
        linkText: 'ติดตามคำขอของคุณ',
        tail: [PRIVACY_TH, NOT_YOU_TH],
      };
    case 'portal_reply_received':
      return {
        subject: `เราได้รับคำตอบของคุณใน ${key} แล้ว`,
        lead: [
          `เราได้รับคำตอบของคุณในคำขอ ${key} แล้ว ทีมซัพพอร์ตจะอ่านและติดต่อกลับ`,
          'ตอนนี้คุณไม่ต้องทำอะไรเพิ่ม',
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
        lead: [`ลิงก์ใหม่สำหรับคำขอ ${key}`],
        linkText: 'เปิดคำขอของคุณ',
        tail: [PRIVACY_TH, 'หากคุณไม่ได้ขออีเมลนี้ ไม่ต้องทำอะไร'],
      };
  }
}

const BUTTON_STYLE =
  'display:inline-block;padding:10px 20px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:bold';

/** Renders one portal email in the language of the job. */
export function renderPortalEmail(job: PortalJob): OutboundMessage {
  const th = job.locale === 'th';
  const copy = th ? thai(job) : english(job);
  const sections: readonly { section: Section; ordered: boolean }[] = [
    ...(copy.recap === undefined ? [] : [{ section: copy.recap, ordered: false }]),
    ...(copy.steps === undefined ? [] : [{ section: copy.steps, ordered: true }]),
  ];
  const text = [
    ...copy.lead,
    ...sections.map(({ section, ordered }) =>
      [
        section.heading,
        ...section.items.map((item, index) =>
          ordered ? `${String(index + 1)}. ${item}` : `- ${item}`,
        ),
      ].join('\n'),
    ),
    `${copy.linkText}:\n${job.trackingUrl}`,
    ...copy.tail,
  ].join('\n\n');
  const url = escapeHtml(job.trackingUrl);
  const html = [
    ...copy.lead.map((line) => `<p>${escapeHtml(line)}</p>`),
    ...sections.map(({ section, ordered }) => {
      const tag = ordered ? 'ol' : 'ul';
      const items = section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<p><strong>${escapeHtml(section.heading)}</strong></p>\n<${tag}>${items}</${tag}>`;
    }),
    `<p><a href="${url}" style="${BUTTON_STYLE}">${escapeHtml(copy.linkText)}</a></p>`,
    `<p>${escapeHtml(th ? 'หากปุ่มไม่ทำงาน คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์:' : 'If the button does not work, copy this link into your browser:')}<br>${url}</p>`,
    ...copy.tail.map((line) => `<p>${escapeHtml(line)}</p>`),
  ].join('\n');
  return { to: job.to, subject: copy.subject, text, html };
}
