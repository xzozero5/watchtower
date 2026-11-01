import { CSAT_SCORE_FRAGMENT_KEY, type EmailJob, type PortalLocale } from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from './html.js';

type CsatJob = Extract<EmailJob, { kind: 'csat_survey' }>;

/**
 * The CSAT survey email (T-110, R-10.2), in English or Thai, one language per email. Five rating
 * links, 1 to 5. A link opens the survey page with that score already chosen; it records nothing
 * until the customer confirms there, so a mail scanner that opens every link cannot answer for them
 * `[ASSUMED]`. No images, no tracking pixel, no external resources.
 */

interface Copy {
  readonly subject: (key: string) => string;
  readonly lead: (key: string) => readonly string[];
  readonly reminderLead: (key: string) => readonly string[];
  readonly scale: string;
  readonly labels: readonly [string, string, string, string, string];
  readonly tail: readonly string[];
}

const COPY: Readonly<Record<PortalLocale, Copy>> = {
  en: {
    subject: (key) => `How did we do on ${key}?`,
    lead: (key) => [
      `Your request ${key} was resolved. How satisfied are you with the support you received?`,
    ],
    reminderLead: (key) => [
      `A reminder: we would still like to hear how we did on your request ${key}.`,
    ],
    scale: 'Choose a rating (1 = very unhappy, 5 = very happy):',
    labels: ['1 - Very unhappy', '2 - Unhappy', '3 - Okay', '4 - Happy', '5 - Very happy'],
    tail: [
      'You can add a comment on the next page. The link works once.',
      'If you did not expect this email, you can ignore it.',
    ],
  },
  th: {
    subject: (key) => `เราให้บริการ ${key} เป็นอย่างไรบ้าง`,
    lead: (key) => [
      `คำขอ ${key} ของคุณได้รับการแก้ไขแล้ว คุณพึงพอใจกับบริการที่ได้รับมากน้อยเพียงใด`,
    ],
    reminderLead: (key) => [`ขอเตือนอีกครั้ง เรายังอยากทราบความเห็นของคุณเกี่ยวกับคำขอ ${key}`],
    scale: 'เลือกคะแนน (1 = ไม่พอใจมาก, 5 = พอใจมาก):',
    labels: ['1 - ไม่พอใจมาก', '2 - ไม่พอใจ', '3 - ปานกลาง', '4 - พอใจ', '5 - พอใจมาก'],
    tail: [
      'คุณเพิ่มความเห็นได้ในหน้าถัดไป ลิงก์ใช้ได้ครั้งเดียว',
      'หากคุณไม่ได้คาดหวังอีเมลนี้ ไม่ต้องทำอะไร',
    ],
  },
};

/** The survey link with a score chosen. The base link keeps its token in the fragment. */
function scoreLink(surveyUrl: string, score: number): string {
  return `${surveyUrl}&${CSAT_SCORE_FRAGMENT_KEY}=${String(score)}`;
}

export function renderCsatEmail(job: CsatJob): OutboundMessage {
  const copy = COPY[job.locale];
  const lead = job.reminder ? copy.reminderLead(job.ticketKey) : copy.lead(job.ticketKey);
  const scores = [1, 2, 3, 4, 5] as const;
  const text = [
    ...lead,
    copy.scale,
    ...scores.map((score) => `${copy.labels[score - 1] ?? ''}: ${scoreLink(job.surveyUrl, score)}`),
    ...copy.tail,
  ].join('\n\n');
  const html = [
    ...lead.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p>${escapeHtml(copy.scale)}</p>`,
    '<p>',
    scores
      .map(
        (score) =>
          `<a href="${escapeHtml(scoreLink(job.surveyUrl, score))}">${escapeHtml(copy.labels[score - 1] ?? '')}</a>`,
      )
      .join('<br>\n'),
    '</p>',
    ...copy.tail.map((line) => `<p>${escapeHtml(line)}</p>`),
  ].join('\n');
  return { to: job.to, subject: copy.subject(job.ticketKey), text, html };
}
