import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '../auth/http-errors.js';
import { decodeCursor, encodeCursor, likeContains, toPage } from './keyset.js';

const ID = '0b3f7a9c-1e0d-4c53-9a5e-6f2f3f4c9d10';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursors', () => {
  it('round-trips a timestamp with microseconds, and infinity', () => {
    for (const v of ['2026-11-02T03:00:00.123456Z', '2026-11-02T03:00:00Z', 'infinity']) {
      expect(decodeCursor(encodeCursor({ v, id: ID }))).toEqual({ v, id: ID });
    }
  });

  it.each([
    ['not base64 json', 'not-a-cursor'],
    ['wrong shape', encode({ x: 1 })],
    ['sql in the value', encode({ v: "2026-01-01'; drop table ticket;--", id: ID })],
    ['bad id', encode({ v: 'infinity', id: 'nope' })],
    ['array', encode([])],
  ])('answers 400 for %s', (_label, value) => {
    let thrown: unknown;
    try {
      decodeCursor(value);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiHttpError);
    expect((thrown as ApiHttpError).getStatus()).toBe(400);
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3, 4].map((n) => ({
    id: ID,
    sortKey: `2026-01-0${String(n)}T00:00:00Z`,
    n,
  }));

  it('cuts the extra row and points the cursor at the last row kept', () => {
    const page = toPage(rows, 3);
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '').v).toBe('2026-01-03T00:00:00Z');
  });

  it('has no cursor on the last page', () => {
    expect(toPage(rows.slice(0, 3), 3).nextCursor).toBeNull();
    expect(toPage([], 3)).toEqual({ rows: [], nextCursor: null });
  });
});

describe('likeContains', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(likeContains('100%')).toBe('%100\\%%');
    expect(likeContains('a_b')).toBe('%a\\_b%');
    expect(likeContains('a\\b')).toBe('%a\\\\b%');
  });

  it('keeps Thai text as it is, and normalizes composed characters', () => {
    expect(likeContains('เข้าสู่ระบบ')).toBe('%เข้าสู่ระบบ%');
    expect(likeContains('é')).toBe('%é%');
  });
});
