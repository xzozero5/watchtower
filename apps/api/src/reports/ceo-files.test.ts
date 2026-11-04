import { describe, expect, it } from 'vitest';

import { CeoCsvError, parseCeoPointsCsv, parseCsv } from './ceo-files.js';
import { reportWindow, windowDays } from './report-window.js';

const HEADER = 'key,label,unit,higher_is_better,value,observed_at';

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, line breaks inside quotes and CRLF', () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n"x\ny",2,3\r\n')).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['x\ny', '2', '3'],
    ]);
  });

  it('skips blank lines and a BOM, and refuses an unclosed quote', () => {
    expect(parseCsv('﻿a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(() => parseCsv('a,"b')).toThrow('never closed');
  });
});

describe('parseCeoPointsCsv', () => {
  it('reads points, defaults higher_is_better to true and normalises the date', () => {
    const points = parseCeoPointsCsv(
      [
        HEADER,
        'uptime,Platform uptime,%,,99.95,2026-11-01',
        'churn,Churn,%,no,2.5,2026-11-01T07:00:00+07:00',
      ].join('\n'),
    );
    expect(points).toEqual([
      {
        key: 'uptime',
        label: 'Platform uptime',
        unit: '%',
        higherIsBetter: true,
        value: 99.95,
        observedAt: '2026-11-01T00:00:00.000Z',
      },
      {
        key: 'churn',
        label: 'Churn',
        unit: '%',
        higherIsBetter: false,
        value: 2.5,
        observedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it.each([
    ['a wrong header', 'key,label\nx,y', 1],
    ['a short row', `${HEADER}\nuptime,Uptime,%`, 2],
    ['a bad number', `${HEADER}\nuptime,Uptime,%,true,abc,2026-11-01`, 2],
    ['an empty number', `${HEADER}\nuptime,Uptime,%,true,,2026-11-01`, 2],
    ['a bad date', `${HEADER}\nuptime,Uptime,%,true,1,yesterday`, 2],
    ['a bad flag', `${HEADER}\nuptime,Uptime,%,maybe,1,2026-11-01`, 2],
    ['a bad key', `${HEADER}\nok,A,,true,1,2026-11-01\nBad Key,B,,true,1,2026-11-01`, 3],
    ['an empty label', `${HEADER}\nuptime,,%,true,1,2026-11-01`, 2],
  ])('names the line of %s', (_name, csv, line) => {
    try {
      parseCeoPointsCsv(csv);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CeoCsvError);
      expect((error as CeoCsvError).line).toBe(line);
    }
  });
});

describe('reportWindow', () => {
  it('is whole UTC days with today included, and the same length right before', () => {
    const window = reportWindow(new Date('2026-11-04T13:25:00Z'), 7);
    expect(window.from.toISOString()).toBe('2026-10-29T00:00:00.000Z');
    expect(window.previousFrom.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(windowDays(window)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });
});
