import { AUDIT_EXPORT_COLUMNS } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { auditCsv, csvCell } from './audit-csv.js';
import type { AuditExportRow } from './audit.service.js';

const row: AuditExportRow = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-11-02T03:00:00.000Z',
  actorType: 'user',
  actorId: '22222222-2222-4222-8222-222222222222',
  action: 'ticket.update',
  outcome: 'success',
  targetType: 'ticket',
  targetId: null,
  requestId: 'req-1',
};

describe('csvCell', () => {
  it('leaves plain text alone and writes null as an empty cell', () => {
    expect(csvCell('ticket.update')).toBe('ticket.update');
    expect(csvCell(null)).toBe('');
  });

  it('quotes a comma, a quote or a line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
  });

  it('defuses spreadsheet formulas', () => {
    for (const value of ['=1+1', '+SUM(A1)', '-2', '@cmd', '\tx', '\rx']) {
      expect(csvCell(value).replace(/^"/, '').startsWith("'"), value).toBe(true);
    }
  });
});

describe('auditCsv', () => {
  it('writes the header, then the rows, with the columns in a fixed order', () => {
    const lines = auditCsv([row]).split('\r\n');
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(','));
    expect(lines[1]).toBe(
      '11111111-1111-4111-8111-111111111111,2026-11-02T03:00:00.000Z,user,22222222-2222-4222-8222-222222222222,ticket.update,success,ticket,,req-1',
    );
    expect(lines[2]).toBe('');
  });

  it('never carries an IP address, before/after or metadata column', () => {
    const header = auditCsv([]).split('\r\n')[0] ?? '';
    for (const forbidden of ['ip', 'before', 'after', 'metadata']) {
      expect(header.split(',')).not.toContain(forbidden);
    }
  });
});
