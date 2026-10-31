import { describe, expect, it } from 'vitest';

import { PG, isPgError, pgCode, pgConstraint } from './errors.js';

describe('database error helpers', () => {
  it('reads the SQLSTATE from the error or from its cause (Drizzle wraps the driver error)', () => {
    expect(pgCode({ code: PG.uniqueViolation })).toBe('23505');
    expect(pgCode({ cause: { code: PG.checkViolation } })).toBe('23514');
    expect(pgCode(new Error('boom'))).toBeUndefined();
    expect(pgCode('23505')).toBeUndefined();
  });

  it('matches a code', () => {
    expect(isPgError({ cause: { code: PG.foreignKeyViolation } }, PG.foreignKeyViolation)).toBe(
      true,
    );
    expect(isPgError({ code: PG.uniqueViolation }, PG.foreignKeyViolation)).toBe(false);
  });

  it('reads the constraint name', () => {
    expect(pgConstraint({ constraint: 'a' })).toBe('a');
    expect(pgConstraint({ cause: { constraint: 'b' } })).toBe('b');
    expect(pgConstraint({})).toBeUndefined();
  });
});
