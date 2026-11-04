import type { StatusLocale } from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from '../processors/html.js';

/**
 * The status page emails (T-204c), in English or Thai, one language per email. No images, no tracking
 * pixel, no external resources. Every notice carries the unsubscribe link; the confirmation carries the
 * confirm link and says what to do if the reader never asked.
 *
 * The notices hold what a person published on the public page, word for word, and nothing else: no
 * incident title, cause, system or customer (the text was written to be read by anyone).
 */

interface Copy {
  readonly confirmSubject: string;
  readonly confirmLead: string;
  readonly confirmCta: string;
  readonly confirmTail: string;
  readonly maintenancePrefix: string;
  readonly window: (starts: string, ends: string) => string;
  readonly components: (names: string) => string;
  readonly pageLine: string;
  readonly unsubscribeLine: string;
}

const COPY: Readonly<Record<StatusLocale, Copy>> = {
  en: {
    confirmSubject: 'Confirm your subscription to status updates',
    confirmLead:
      'Someone asked to receive status updates by email at this address. Confirm that it was you:',
    confirmCta: 'Confirm my subscription',
    confirmTail:
      'The link opens a page where you press one button; nothing is subscribed until you do. If you did not ask for this, ignore this email and nothing will be sent to you.',
    maintenancePrefix: 'Scheduled maintenance',
    window: (starts, ends) => `Planned window (UTC): ${starts} to ${ends}`,
    components: (names) => `Affected: ${names}`,
    pageLine: 'Current status:',
    unsubscribeLine: 'Stop these emails:',
  },
  th: {
    confirmSubject: 'ยืนยันการติดตามสถานะบริการ',
    confirmLead: 'มีผู้ขอรับอีเมลแจ้งสถานะบริการที่ที่อยู่นี้ ยืนยันว่าเป็นคุณ:',
    confirmCta: 'ยืนยันการติดตาม',
    confirmTail:
      'ลิงก์จะเปิดหน้าที่ให้คุณกดปุ่มเดียว จะไม่มีการสมัครจนกว่าคุณจะกด หากคุณไม่ได้ขอ ไม่ต้องทำอะไร เราจะไม่ส่งอีเมลถึงคุณ',
    maintenancePrefix: 'ปิดปรับปรุงตามกำหนด',
    window: (starts, ends) => `ช่วงเวลา (UTC): ${starts} ถึง ${ends}`,
    components: (names) => `ได้รับผลกระทบ: ${names}`,
    pageLine: 'สถานะปัจจุบัน:',
    unsubscribeLine: 'ยกเลิกการรับอีเมลนี้:',
  },
};

export function renderConfirmation(input: {
  readonly to: string;
  readonly locale: StatusLocale;
  readonly confirmUrl: string;
}): OutboundMessage {
  const copy = COPY[input.locale];
  return {
    to: input.to,
    subject: copy.confirmSubject,
    text: [copy.confirmLead, input.confirmUrl, copy.confirmTail].join('\n\n'),
    html: [
      `<p>${escapeHtml(copy.confirmLead)}</p>`,
      `<p><a href="${escapeHtml(input.confirmUrl)}">${escapeHtml(copy.confirmCta)}</a></p>`,
      `<p>${escapeHtml(copy.confirmTail)}</p>`,
    ].join('\n'),
  };
}

export function renderNotice(input: {
  readonly to: string;
  readonly locale: StatusLocale;
  readonly kind: 'post' | 'maintenance';
  readonly title: string;
  readonly body: string;
  readonly componentNames: readonly string[];
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly pageUrl: string;
  readonly unsubscribeUrl: string;
  /** The RFC 8058 one-click endpoint of this subscription; adds `List-Unsubscribe` and `List-Unsubscribe-Post`. */
  readonly oneClickUnsubscribeUrl?: string | undefined;
}): OutboundMessage {
  const copy = COPY[input.locale];
  const subject =
    input.kind === 'maintenance' ? `${copy.maintenancePrefix}: ${input.title}` : input.title;
  const lines = [
    input.body,
    ...(input.startsAt !== undefined && input.endsAt !== undefined
      ? [copy.window(input.startsAt.toISOString(), input.endsAt.toISOString())]
      : []),
    ...(input.componentNames.length > 0 ? [copy.components(input.componentNames.join(', '))] : []),
  ];
  return {
    to: input.to,
    subject: subject.replaceAll(/[\r\n]+/g, ' '),
    ...(input.oneClickUnsubscribeUrl === undefined
      ? {}
      : {
          headers: {
            'List-Unsubscribe': `<${input.oneClickUnsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        }),
    text: [
      ...lines,
      `${copy.pageLine} ${input.pageUrl}`,
      `${copy.unsubscribeLine} ${input.unsubscribeUrl}`,
    ].join('\n\n'),
    html: [
      ...lines.map((line) => `<p>${escapeHtml(line).replaceAll('\n', '<br>')}</p>`),
      `<p>${escapeHtml(copy.pageLine)} <a href="${escapeHtml(input.pageUrl)}">${escapeHtml(input.pageUrl)}</a></p>`,
      `<p><small>${escapeHtml(copy.unsubscribeLine)} <a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(input.unsubscribeUrl)}</a></small></p>`,
    ].join('\n'),
  };
}
