import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { CeoView } from '@watchtower/shared';
import PDFDocument from 'pdfkit';

import { formulaText, rowsOf, type ExportRow } from './ceo-files.js';

/**
 * The CEO view as a PDF (T-305d, ADR-028). Pure JS (`pdfkit`), no browser and no network. Text is set in
 * IBM Plex Sans Thai, the face the web app already self-hosts (OFL 1.1): the Thai subset for U+0E00-0E7F
 * and the Latin subset for everything else. Fonts are embedded as subsets with a ToUnicode map, so the
 * text can be selected and extracted.
 */

const require = createRequire(import.meta.url);
const fontDir = join(dirname(require.resolve('@fontsource/ibm-plex-sans-thai')), 'files');
const FONTS = {
  latin: join(fontDir, 'ibm-plex-sans-thai-latin-400-normal.woff'),
  latinBold: join(fontDir, 'ibm-plex-sans-thai-latin-600-normal.woff'),
  thai: join(fontDir, 'ibm-plex-sans-thai-thai-400-normal.woff'),
  thaiBold: join(fontDir, 'ibm-plex-sans-thai-thai-600-normal.woff'),
} as const;

const THAI = /[฀-๿]/u;
const MARGIN = 40;
const ROW_FONT = 9;
const TABLE_WIDTH = 515;

interface Run {
  thai: boolean;
  text: string;
}

/** Splits a string into Thai and non-Thai runs (spaces, digits and punctuation use the Latin face). */
export function fontRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const char of text) {
    const thai = THAI.test(char);
    const last = runs[runs.length - 1];
    if (last && last.thai === thai) last.text += char;
    else runs.push({ thai, text: char });
  }
  return runs;
}

type Doc = InstanceType<typeof PDFDocument>;

function setFace(doc: Doc, thai: boolean, bold: boolean): void {
  doc.font(`${thai ? 'thai' : 'latin'}${bold ? 'Bold' : ''}`);
}

function widthOf(doc: Doc, text: string, size: number, bold: boolean): number {
  let total = 0;
  for (const run of fontRuns(text)) {
    setFace(doc, run.thai, bold);
    total += doc.fontSize(size).widthOfString(run.text);
  }
  return total;
}

/** Greedy wrap on word boundaries (Intl.Segmenter knows Thai words); a word wider than the cell is cut. */
function wrap(doc: Doc, text: string, width: number, size: number, bold: boolean): string[] {
  const lines: string[] = [];
  let line = '';
  const push = (piece: string): void => {
    if (line === '' || widthOf(doc, line + piece, size, bold) <= width) {
      line += piece;
      return;
    }
    lines.push(line.trimEnd());
    line = piece.trimStart();
  };
  for (const { segment } of new Intl.Segmenter('th', { granularity: 'word' }).segment(text)) {
    if (widthOf(doc, segment, size, bold) <= width) {
      push(segment);
      continue;
    }
    for (const char of segment) push(char);
  }
  if (line !== '') lines.push(line.trimEnd());
  return lines.length > 0 ? lines : [''];
}

function drawLine(
  doc: Doc,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  bold: boolean,
  align: 'left' | 'right',
): void {
  let cursor = align === 'right' ? x + width - widthOf(doc, text, size, bold) : x;
  for (const run of fontRuns(text)) {
    setFace(doc, run.thai, bold);
    doc.fontSize(size).text(run.text, cursor, y, { lineBreak: false });
    cursor += doc.widthOfString(run.text);
  }
}

const COLUMNS = [
  { title: 'Figure', width: 145, align: 'left' },
  { title: 'Value', width: 62, align: 'right' },
  { title: 'Previous', width: 62, align: 'right' },
  { title: 'Unit', width: 56, align: 'left' },
  { title: 'Note', width: 190, align: 'left' },
] as const;

const cells = (row: ExportRow): string[] => [
  row.label,
  row.value,
  row.previous,
  row.unit,
  row.note,
];

/** A PDF of the view; the dates come from `generatedAt`, not from the clock. */
export function ceoPdf(view: CeoView): Promise<Buffer> {
  const range = `${view.window.from.slice(0, 10)} to ${view.window.to.slice(0, 10)}`;
  const previous = `${view.previous.from.slice(0, 10)} to ${view.previous.to.slice(0, 10)}`;
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    compress: true,
    info: {
      Title: `CEO view, ${range}`,
      Producer: 'Watchtower',
      Creator: 'Watchtower',
      CreationDate: new Date(view.generatedAt),
    },
  });
  for (const [name, path] of Object.entries(FONTS)) doc.registerFont(name, path);

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  const left = MARGIN;
  const bottom = doc.page.height - MARGIN;
  let y = MARGIN;
  const rule = (at: number, weight: number, color: string): void => {
    doc
      .moveTo(left, at)
      .lineTo(left + TABLE_WIDTH, at)
      .lineWidth(weight)
      .strokeColor(color)
      .stroke();
  };

  drawLine(doc, 'CEO view', left, y, 400, 20, true, 'left');
  y += 30;
  const intro = `${range} (UTC days), compared with ${previous}. Generated ${view.generatedAt}.`;
  for (const line of wrap(doc, intro, TABLE_WIDTH, 9, false)) {
    drawLine(doc, line, left, y, TABLE_WIDTH, 9, false, 'left');
    y += 13;
  }
  if (view.seedExcluded) {
    drawLine(doc, 'Demo (seed) tickets are not counted.', left, y, TABLE_WIDTH, 9, false, 'left');
    y += 13;
  }
  y += 8;

  const header = (): void => {
    let x = left;
    for (const col of COLUMNS) {
      drawLine(doc, col.title, x + 2, y, col.width - 4, ROW_FONT, true, col.align);
      x += col.width;
    }
    y += 14;
    rule(y - 2, 0.8, '#16202a');
  };
  header();

  for (const row of rowsOf(view)) {
    const wrapped = cells(row).map((text, index) =>
      wrap(doc, text, (COLUMNS[index]?.width ?? 60) - 4, ROW_FONT, false),
    );
    const lines = Math.max(...wrapped.map((cell) => cell.length));
    const height = lines * 12 + 6;
    if (y + height > bottom - 40) {
      doc.addPage();
      y = MARGIN;
      header();
    }
    let x = left;
    wrapped.forEach((cell, index) => {
      const col = COLUMNS[index];
      if (!col) return;
      cell.forEach((text, lineIndex) => {
        drawLine(doc, text, x + 2, y + lineIndex * 12, col.width - 4, ROW_FONT, false, col.align);
      });
      x += col.width;
    });
    y += height;
    rule(y - 2, 0.3, '#d5dbe1');
  }

  y += 10;
  for (const line of wrap(doc, formulaText(view.formula), TABLE_WIDTH, 9, false)) {
    if (y + 13 > bottom) {
      doc.addPage();
      y = MARGIN;
    }
    drawLine(doc, line, left, y, TABLE_WIDTH, 9, false, 'left');
    y += 13;
  }
  doc.end();
  return done;
}
