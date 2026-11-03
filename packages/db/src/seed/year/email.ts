import type { Lang } from './world.js';
import { localParts } from './prng.js';

/**
 * Builds the two bodies of an email message from one structure: plain text and Gmail-like HTML
 * (signature, quoted reply "On ... wrote:", tables, inline image reference). The HTML is what a
 * mailbox would hand over: tags and attributes of Gmail's web composer, Outlook's WordSection and a
 * plain composer, so a renderer is exercised with the shapes it will meet.
 */

export type MailStyle = 'gmail' | 'outlook' | 'composer';

export interface MailPerson {
  readonly name: string;
  readonly address: string;
}

export interface MailParts {
  readonly style: MailStyle;
  readonly lang: Lang;
  readonly greeting?: string;
  /** Paragraphs separated as written; `\n` inside one is a line break. */
  readonly paragraphs: readonly string[];
  readonly table?: { readonly headers: readonly string[]; readonly rows: readonly string[][] };
  /** An image shown inside the message (`cid:` reference). */
  readonly inlineImage?: { readonly contentId: string; readonly alt: string };
  readonly regards?: string;
  readonly signature: readonly string[];
  readonly quote?: { readonly author: MailPerson; readonly at: Date; readonly text: string };
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const TH_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

/** The attribution line a mail client writes above a quoted reply. */
export function attribution(lang: Lang, author: MailPerson, at: Date, html: boolean): string {
  const p = localParts(at);
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const who = html
    ? `${escapeHtml(author.name)} &lt;${escapeHtml(author.address)}&gt;`
    : `${author.name} <${author.address}>`;
  if (lang === 'th') {
    return `เมื่อ ${String(p.day)} ${TH_MONTHS[p.month - 1] ?? ''} ${String(p.year + 543)} เวลา ${time} น. ${who} เขียนว่า:`;
  }
  return `On ${EN_DAYS[p.weekday] ?? ''}, ${String(p.day)} ${EN_MONTHS[p.month - 1] ?? ''} ${String(p.year)} at ${time}, ${who} wrote:`;
}

function toHtmlParagraph(text: string, style: MailStyle): string {
  // Highlight request ids the way people bold them in a mail.
  const body = escapeHtml(text)
    .replace(/(req_[0-9a-f]{8})/g, '<b>$1</b>')
    .replaceAll('\n', '<br>');
  if (style === 'outlook') {
    return `<p class="MsoNormal"><span style="font-size:11.0pt;font-family:Calibri,sans-serif">${body}</span></p>`;
  }
  if (style === 'composer') return `<p>${body}</p>`;
  return `<div>${body}</div><div><br></div>`;
}

function tableHtml(table: NonNullable<MailParts['table']>, style: MailStyle): string {
  const head = table.headers
    .map(
      (h) =>
        `<th style="border:1px solid #bbb;padding:4px 8px;background:#f1f3f4;text-align:left">${escapeHtml(h)}</th>`,
    )
    .join('');
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) => `<td style="border:1px solid #bbb;padding:4px 8px">${escapeHtml(cell)}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  const grid = `<table style="border-collapse:collapse;font-size:13px" cellspacing="0" cellpadding="0"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
  return style === 'gmail' ? `<div>${grid}</div><div><br></div>` : grid;
}

function signatureHtml(lines: readonly string[], style: MailStyle): string {
  const inner = lines.map((l) => escapeHtml(l)).join('<br>');
  if (style === 'gmail') {
    return `<div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><div>${inner}</div></div></div></div>`;
  }
  if (style === 'outlook') {
    return `<p class="MsoNormal"><span style="font-size:10.0pt;font-family:Calibri,sans-serif;color:#595959">${inner}</span></p>`;
  }
  return `<p style="color:#555">${inner}</p>`;
}

function quoteHtml(quote: NonNullable<MailParts['quote']>, lang: Lang, style: MailStyle): string {
  const inner = quote.text
    .split('\n')
    .map((line) => (line === '' ? '<br>' : `<div>${escapeHtml(line)}</div>`))
    .join('');
  const attr = attribution(lang, quote.author, quote.at, true);
  if (style === 'outlook') {
    return `<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>${attr}</b></p></div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`;
  }
  return `<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${attr}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${inner}</blockquote></div>`;
}

export interface RenderedMail {
  readonly text: string;
  readonly html: string;
}

export function renderMail(parts: MailParts): RenderedMail {
  const textLines: string[] = [];
  if (parts.greeting) textLines.push(parts.greeting, '');
  for (const paragraph of parts.paragraphs) textLines.push(paragraph, '');
  if (parts.table) {
    textLines.push(parts.table.headers.join(' | '));
    for (const row of parts.table.rows) textLines.push(row.join(' | '));
    textLines.push('');
  }
  if (parts.inlineImage) textLines.push(`[image: ${parts.inlineImage.alt}]`, '');
  if (parts.regards) textLines.push(parts.regards);
  textLines.push(...parts.signature);
  if (parts.quote) {
    textLines.push('', attribution(parts.lang, parts.quote.author, parts.quote.at, false));
    for (const line of parts.quote.text.split('\n'))
      textLines.push(line === '' ? '>' : `> ${line}`);
  }
  const text = textLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const body: string[] = [];
  if (parts.greeting) body.push(toHtmlParagraph(parts.greeting, parts.style));
  for (const paragraph of parts.paragraphs) body.push(toHtmlParagraph(paragraph, parts.style));
  if (parts.table) body.push(tableHtml(parts.table, parts.style));
  if (parts.inlineImage) {
    body.push(
      `<div><img src="cid:${parts.inlineImage.contentId}" alt="${escapeHtml(parts.inlineImage.alt)}" width="480" height="270" style="max-width:100%"></div><div><br></div>`,
    );
  }
  if (parts.regards) body.push(toHtmlParagraph(parts.regards, parts.style));
  body.push(signatureHtml(parts.signature, parts.style));
  if (parts.quote) body.push(quoteHtml(parts.quote, parts.lang, parts.style));
  const inner = body.join('');
  const html =
    parts.style === 'gmail'
      ? `<div dir="ltr">${inner}</div>`
      : parts.style === 'outlook'
        ? `<div class="WordSection1">${inner}</div>`
        : `<div>${inner}</div>`;
  return { text, html };
}
