import { AUDIT_EXPORT_COLUMNS } from '@watchtower/shared';

import type { AuditExportRow } from './audit.service.js';

/** Characters that make a spreadsheet read a cell as a formula (OWASP "CSV injection"). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell (RFC 4180). A value that a spreadsheet could run as a formula gets a leading
 * apostrophe, and anything with a comma, a quote or a line break is quoted. Values here come from
 * the log (actor ids, request ids, action names), some of them typed by an outside caller, so none
 * of them is trusted.
 */
export function csvCell(value: string | null): string {
  if (value === null) return '';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The export as CSV text: a header row, then one row per entry, `\r\n` line ends. */
export function auditCsv(rows: readonly AuditExportRow[]): string {
  const lines = [AUDIT_EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(AUDIT_EXPORT_COLUMNS.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
