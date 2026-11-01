import { describe, expect, it } from 'vitest';

import { ConnectorQueryRejectedError } from '../common/errors.js';
import { matchesLogFilter, parseLogFilter, quoteLogLiteral, renderLogFilter } from './filter.js';
import type { LogEntry } from './types.js';

const entry = (fields: Partial<LogEntry>): LogEntry => ({
  insertId: 'i-1',
  timestamp: '2026-01-01T10:00:00.000Z',
  severity: 'ERROR',
  service: 'svc-a',
  message: 'Delivery failed after 3 retries',
  labels: { org_ref: 'org-1' },
  ...fields,
});

describe('renderLogFilter', () => {
  it('fills placeholders with quoted literals', () => {
    expect(
      renderLogFilter('service="svc-a" AND labels.org_ref={{org_id}}', { org_id: 'org-1' }),
    ).toBe('service="svc-a" AND labels.org_ref="org-1"');
  });

  it.each([
    ['a quote that would close the literal', 'x" OR severity>=DEFAULT OR "y'],
    ['a backslash', 'a\\'],
    ['a space', 'a b'],
    ['a newline', 'a\nb'],
    ['a wildcard', 'a*'],
    ['an empty value', ''],
  ])('refuses a value with %s', (_name, value) => {
    expect(() => renderLogFilter('labels.org_ref={{org_id}}', { org_id: value })).toThrow(
      ConnectorQueryRejectedError,
    );
  });

  it('refuses a missing, an unknown and a malformed placeholder', () => {
    expect(() => renderLogFilter('labels.a={{a}} AND labels.b={{b}}', { a: '1' })).toThrow(/Missing/);
    expect(() => renderLogFilter('labels.a={{a}}', { a: '1', b: '2' })).toThrow(/Unknown/);
    expect(() => renderLogFilter('labels.a={{A}}', { a: '1' })).toThrow(/malformed/);
  });

  it('quotes with escapes for a literal built by hand', () => {
    expect(quoteLogLiteral('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('parseLogFilter and matchesLogFilter', () => {
  it('reads service, labels, severity and text terms', () => {
    const terms = parseLogFilter('service="svc-a" AND labels.org_ref="org-1" severity>=WARNING "retries"');
    expect(terms).toHaveLength(4);
    expect(matchesLogFilter(entry({}), terms)).toBe(true);
    expect(matchesLogFilter(entry({ service: 'svc-b' }), terms)).toBe(false);
    expect(matchesLogFilter(entry({ labels: { org_ref: 'org-2' } }), terms)).toBe(false);
    expect(matchesLogFilter(entry({ severity: 'INFO' }), terms)).toBe(false);
    expect(matchesLogFilter(entry({ message: 'all fine' }), terms)).toBe(false);
  });

  it('keeps a quoted value with spaces in one term and ignores the case of the text term', () => {
    const terms = parseLogFilter('labels.note="two words" "DELIVERY failed"');
    expect(matchesLogFilter(entry({ labels: { note: 'two words' } }), terms)).toBe(true);
  });

  it('accepts an empty filter and refuses what it cannot read', () => {
    expect(parseLogFilter('')).toEqual([]);
    expect(() => parseLogFilter('unknownField="x"')).toThrow(ConnectorQueryRejectedError);
    expect(() => parseLogFilter('severity>=LOUD')).toThrow(/severity/);
    expect(() => parseLogFilter('service="open')).toThrow(/Unterminated/);
    expect(() => parseLogFilter('a'.repeat(2001))).toThrow(/too long/);
  });
});
