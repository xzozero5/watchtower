import type { EmailJob, PortalLocale } from '@watchtower/shared';

import type { OutboundMessage } from '../mailer.js';
import { escapeHtml } from './html.js';

type BriefJob = Extract<EmailJob, { kind: 'weekly_brief' }>;

/**
 * The weekly brief email (T-305c): the text the head published, one language per email (the language of the
 * brief), plain text and simple HTML with inline CSS only (no image, no tracking pixel, no external resource).
 * Each line already carries the names of what it rests on (`[OPS-12, INC-3]`) or says it has no evidence;
 * the link opens the page where those names are links.
 */
interface Copy {
  readonly subject: (from: string, to: string) => string;
  readonly lead: string;
  readonly summary: string;
  readonly rootCauses: string;
  readonly ask: string;
  readonly decisions: string;
  readonly open: string;
  readonly tail: string;
}

const COPY: Readonly<Record<PortalLocale, Copy>> = {
  en: {
    subject: (from, to) => `Weekly brief ${from} to ${to}`,
    lead: 'The weekly brief of the support and operations team, published by the head.',
    summary: 'This week',
    rootCauses: 'Top root causes',
    ask: 'Suggested ask',
    decisions: 'Decisions needed',
    open: 'Open the brief with its evidence links:',
    tail: 'Figures are as of the time the brief was made. A line marked "no evidence" was written by a person.',
  },
  th: {
    subject: (from, to) => `สรุปรายสัปดาห์ ${from} ถึง ${to}`,
    lead: 'สรุปรายสัปดาห์ของทีม support และ operations เผยแพร่โดยหัวหน้าทีม',
    summary: 'สัปดาห์นี้',
    rootCauses: 'สาเหตุหลัก',
    ask: 'ข้อเสนอที่แนะนำ',
    decisions: 'เรื่องที่ต้องตัดสินใจ',
    open: 'เปิดสรุปพร้อมลิงก์หลักฐาน:',
    tail: 'ตัวเลขเป็น ณ เวลาที่ทำสรุป บรรทัดที่ระบุว่า "no evidence" คนเป็นผู้เขียน',
  },
};

const day = (iso: string): string => iso.slice(0, 10);

export function renderWeeklyBriefEmail(job: BriefJob): OutboundMessage {
  const copy = COPY[job.locale];
  const text: string[] = [copy.lead, ''];
  const html: string[] = [`<p>${escapeHtml(copy.lead)}</p>`];
  const section = (title: string, lines: readonly string[]): void => {
    if (lines.length === 0) return;
    text.push(title, ...lines.map((line) => `- ${line}`), '');
    html.push(
      `<h3 style="margin:16px 0 4px">${escapeHtml(title)}</h3>`,
      `<ul style="margin:0;padding-left:20px">${lines
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ul>`,
    );
  };
  section(copy.summary, job.summary);
  const causes = job.rootCauses.map(
    (cause) =>
      `${cause.title}: ${cause.text}${cause.ask === null ? '' : ` (${copy.ask}: ${cause.ask})`}`,
  );
  section(copy.rootCauses, causes);
  section(copy.decisions, job.decisions);
  text.push(copy.open, job.pageUrl, '', copy.tail);
  html.push(
    `<p>${escapeHtml(copy.open)} <a href="${escapeHtml(job.pageUrl)}">${escapeHtml(job.pageUrl)}</a></p>`,
    `<p style="color:#555">${escapeHtml(copy.tail)}</p>`,
  );
  return {
    to: job.to,
    subject: copy.subject(day(job.periodFrom), day(job.periodTo)),
    text: text.join('\n'),
    html: html.join('\n'),
  };
}
