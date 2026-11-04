import {
  CEO_IMPORT_HEADER,
  ceoPointSchema,
  type CeoKpiKey,
  type CeoPoint,
  type CeoView,
} from '@watchtower/shared';

import { csvCell } from '../audit/audit-csv.js';

// --- reading a CSV (the import of pluggable tiles) ---------------------------------------------------

/** RFC 4180 records: quoted cells, doubled quotes, line breaks inside quotes. Returns the cells per line. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\u{FEFF}/u, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    if (quoted) {
      if (char === '"' && source.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(index + 1) === '\n') index += 1;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('a quoted cell is never closed');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => !(cells.length === 1 && cells[0]?.trim() === ''));
}

export class CeoCsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${String(line)}: ${message}`);
  }
}

const BOOLEANS: Readonly<Record<string, boolean>> = {
  true: true,
  '1': true,
  yes: true,
  false: false,
  '0': false,
  no: false,
};

/**
 * The points in a CSV with the header `key,label,unit,higher_is_better,value,observed_at`. All or nothing:
 * the first bad row throws a `CeoCsvError` naming its line (the header is line 1).
 */
export function parseCeoPointsCsv(text: string): CeoPoint[] {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (error) {
    throw new CeoCsvError(1, error instanceof Error ? error.message : 'unreadable');
  }
  const [header, ...body] = rows;
  if (
    header === undefined ||
    header.map((cell) => cell.trim().toLowerCase()).join(',') !== CEO_IMPORT_HEADER.join(',')
  ) {
    throw new CeoCsvError(1, `the header must be ${CEO_IMPORT_HEADER.join(',')}`);
  }
  return body.map((cells, offset) => {
    const line = offset + 2;
    if (cells.length !== CEO_IMPORT_HEADER.length) {
      throw new CeoCsvError(
        line,
        `expected ${String(CEO_IMPORT_HEADER.length)} columns, found ${String(cells.length)}`,
      );
    }
    const [key, label, unit, better, value, observed] = cells.map((cell) => cell.trim()) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const higherIsBetter = better === '' ? true : BOOLEANS[better.toLowerCase()];
    if (higherIsBetter === undefined)
      throw new CeoCsvError(line, 'higher_is_better is true or false');
    const number = value === '' ? Number.NaN : Number(value);
    if (!Number.isFinite(number)) throw new CeoCsvError(line, 'value is not a number');
    const when = /^\d{4}-\d{2}-\d{2}/.test(observed) ? new Date(observed) : new Date(Number.NaN);
    if (Number.isNaN(when.getTime())) throw new CeoCsvError(line, 'observed_at is not a date');
    const parsed = ceoPointSchema.safeParse({
      key,
      label,
      unit,
      higherIsBetter,
      value: number,
      observedAt: when.toISOString(),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CeoCsvError(
        line,
        `${issue?.path.join('.') ?? 'row'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    return parsed.data;
  });
}

// --- writing the view (the export) -------------------------------------------------------------------

export const CEO_KPI_LABELS: Readonly<Record<CeoKpiKey, { label: string; unit: string }>> = {
  volume: { label: 'Ticket volume', unit: 'tickets' },
  firstResponse: { label: 'First response, median', unit: 'seconds' },
  resolution: { label: 'Resolution time, median', unit: 'seconds' },
  sla: { label: 'SLA compliance', unit: 'ratio' },
  csat: { label: 'CSAT, average', unit: 'score 1-5' },
  aiHandled: { label: 'AI-assisted share of resolved tickets', unit: 'ratio' },
  verifiedResolution: { label: 'Verified-resolution rate', unit: 'ratio' },
  automationSavings: { label: 'Automation savings', unit: 'hours' },
};

const KPI_ORDER = Object.keys(CEO_KPI_LABELS) as CeoKpiKey[];

export interface ExportRow {
  readonly kind: 'kpi' | 'external';
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly value: string;
  readonly previous: string;
  readonly note: string;
}

const NOT_AVAILABLE: Readonly<Record<string, string>> = {
  no_data: 'no data in this window',
  needs_grader: 'waits for the AI grader',
  not_collected: 'not collected yet',
  not_implemented: 'not built yet',
};

export function rowsOf(view: CeoView): ExportRow[] {
  const kpis = KPI_ORDER.map((key): ExportRow => {
    const meta = CEO_KPI_LABELS[key];
    const figure = view.kpis[key];
    if (figure.status === 'ok') {
      return {
        kind: 'kpi',
        key,
        ...meta,
        value: String(figure.data.value),
        previous: figure.data.previous === null ? '' : String(figure.data.previous),
        note: `${String(figure.data.samples)} samples`,
      };
    }
    return {
      kind: 'kpi',
      key,
      ...meta,
      value: '',
      previous: '',
      note:
        figure.status === 'restricted'
          ? 'not visible to this role'
          : (NOT_AVAILABLE[figure.reason] ?? 'not available'),
    };
  });
  const external = view.externalTiles.map((tile): ExportRow => ({
    kind: 'external',
    key: tile.key,
    label: tile.label,
    unit: tile.unit,
    value: String(tile.value),
    previous: tile.previous === null ? '' : String(tile.previous),
    note: `observed ${tile.observedAt}`,
  }));
  return [...kpis, ...external];
}

/** The formula in words, as the page prints it. */
export function formulaText(formula: CeoView['formula']): string {
  const cost =
    formula.staffCostUsdPerHour === null
      ? 'No hourly cost is set, so only hours are shown.'
      : `Saved cost = hours x ${String(formula.staffCostUsdPerHour)} USD per hour.`;
  return (
    `Automation savings (assumption, not a measurement): hours = AI-assisted resolved tickets x ` +
    `${String(formula.minutesPerTicket)} minutes / 60. ${cost}`
  );
}

/** The CEO view as CSV: one line per KPI and per pluggable tile. Cells a spreadsheet could run are defused. */
export function ceoCsv(view: CeoView): string {
  const lines = [['kind', 'key', 'label', 'unit', 'value', 'previous', 'note'].join(',')];
  for (const row of rowsOf(view)) {
    lines.push(
      [row.kind, row.key, row.label, row.unit, row.value, row.previous, row.note]
        .map((cell) => csvCell(cell))
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** The CEO view as one self-contained HTML page (no script, no outside request). Everything is escaped. */
export function ceoHtml(view: CeoView): string {
  const range = `${view.window.from.slice(0, 10)} to ${view.window.to.slice(0, 10)}`;
  const previous = `${view.previous.from.slice(0, 10)} to ${view.previous.to.slice(0, 10)}`;
  const body = rowsOf(view)
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.label)}</td><td class="n">${escapeHtml(row.value)}</td>` +
        `<td class="n">${escapeHtml(row.previous)}</td><td>${escapeHtml(row.unit)}</td>` +
        `<td>${escapeHtml(row.note)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CEO view, ${escapeHtml(range)}</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem;color:#16202a}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d5dbe1;padding:.4rem .5rem;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}p{color:#4a5560}
</style>
</head>
<body>
<h1>CEO view</h1>
<p>${escapeHtml(range)} (UTC days), compared with ${escapeHtml(previous)}. Generated ${escapeHtml(view.generatedAt)}.</p>
${view.seedExcluded ? '<p>Demo (seed) tickets are not counted.</p>' : ''}
<table>
<thead><tr><th>Figure</th><th class="n">Value</th><th class="n">Previous</th><th>Unit</th><th>Note</th></tr></thead>
<tbody>
${body}
</tbody>
</table>
<p>${escapeHtml(formulaText(view.formula))}</p>
</body>
</html>
`;
}
