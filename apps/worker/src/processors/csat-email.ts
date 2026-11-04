import { CSAT_SCORE_FRAGMENT_KEY, type EmailJob, type PortalLocale } from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from './html.js';

type CsatJob = Extract<EmailJob, { kind: 'csat_survey' }>;

/**
 * The CSAT survey email (T-110, R-10.2), in English or Thai, one language per email. Five rating
 * links, 1 to 5. A link opens the survey page with that score already chosen; it records nothing
 * until the customer confirms there, so a mail scanner that opens every link cannot answer for them
 * `[ASSUMED]`. HTML in the brand colors with inline CSS only (T-174): no images, no tracking pixel, no
 * external resources, no `<style>` block; the plain-text part carries the same five links.
 */

interface Copy {
  readonly subject: (key: string) => string;
  readonly lead: (key: string) => readonly string[];
  readonly reminderLead: (key: string) => readonly string[];
  readonly scale: string;
  readonly labels: readonly [string, string, string, string, string];
  readonly tail: readonly string[];
  /** Shown under the buttons for a client that does not draw them. */
  readonly fallback: string;
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
    fallback: 'Buttons not showing? Open the survey here:',
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
    fallback: 'ปุ่มไม่แสดง? เปิดแบบสำรวจที่นี่:',
  },
};

/** The survey link with a score chosen. The base link keeps its token in the fragment. */
function scoreLink(surveyUrl: string, score: number): string {
  return `${surveyUrl}&${CSAT_SCORE_FRAGMENT_KEY}=${String(score)}`;
}

// Brand colors (docs/brand/README.md): midnight navy for the action, ivory/cream for the canvas, the
// golden beacon as the one accent. The coral of the logo stays out of buttons (alert discipline).
const NAVY = '#0F172A';
const NAVY_SOFT = '#1E293B';
const CREAM = '#F7F7ED';
const IVORY = '#F7F0D4';
const GOLD = '#F59E0B';
const CHARCOAL = '#363839';
const MUTED = '#5B6472';
const FONT = "'Sarabun','Noto Sans Thai',Tahoma,'Segoe UI',Helvetica,Arial,sans-serif";

/** One rating button: a navy square with the number and its word underneath, both the same link. */
function ratingCell(href: string, score: number, label: string): string {
  const word = label.replace(/^\d\s*-\s*/, '');
  return [
    '<td align="center" valign="top" width="20%" style="padding:0 3px;">',
    `<a href="${escapeHtml(href)}" aria-label="${escapeHtml(label)}" style="display:block;text-decoration:none;color:${IVORY};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td align="center" bgcolor="${NAVY}" style="background-color:${NAVY};border-radius:10px;border-bottom:3px solid ${GOLD};padding:14px 0;font-family:${FONT};font-size:24px;line-height:28px;font-weight:700;color:#FFFFFF;">${String(score)}</td>`,
    '</tr></table>',
    `<span style="display:block;padding-top:6px;font-family:${FONT};font-size:12px;line-height:16px;color:${NAVY_SOFT};">${escapeHtml(word)}</span>`,
    '</a>',
    '</td>',
  ].join('');
}

function renderHtml(
  job: CsatJob,
  copy: Copy,
  lead: readonly string[],
  scores: readonly (1 | 2 | 3 | 4 | 5)[],
): string {
  const paragraph = (line: string, extra = ''): string =>
    `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:24px;color:${CHARCOAL};${extra}">${escapeHtml(line)}</p>`;
  const cells = scores
    .map((score) =>
      ratingCell(scoreLink(job.surveyUrl, score), score, copy.labels[score - 1] ?? ''),
    )
    .join('');
  const preheader = lead[0] ?? '';
  return [
    '<!doctype html>',
    `<html lang="${job.locale}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeHtml(copy.subject(job.ticketKey))}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;background-color:${CREAM};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${CREAM};">${escapeHtml(preheader)}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CREAM}" style="background-color:${CREAM};"><tr><td align="center" style="padding:24px 12px;">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">',
    // Header: the wordmark in text (no image to load, nothing to track).
    `<tr><td bgcolor="${NAVY}" style="background-color:${NAVY};border-radius:12px 12px 0 0;border-bottom:4px solid ${GOLD};padding:18px 24px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;letter-spacing:0.5px;color:${IVORY};">Watchtower</td></tr>`,
    `<tr><td bgcolor="#FFFFFF" style="background-color:#FFFFFF;border-radius:0 0 12px 12px;padding:28px 24px 24px 24px;">`,
    ...lead.map((line) => paragraph(line)),
    paragraph(copy.scale, `font-size:14px;color:${MUTED};`),
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;"><tr>',
    cells,
    '</tr></table>',
    ...copy.tail.map((line) => paragraph(line, `font-size:13px;line-height:20px;color:${MUTED};`)),
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(copy.fallback)} <a href="${escapeHtml(job.surveyUrl)}" style="color:${NAVY};">${escapeHtml(job.surveyUrl)}</a></p>`,
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body>',
    '</html>',
  ].join('\n');
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
  return {
    to: job.to,
    subject: copy.subject(job.ticketKey),
    text,
    html: renderHtml(job, copy, lead, scores),
  };
}
