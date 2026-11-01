/** Postgres error classes the services translate into API errors. */
export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  /** statement_timeout (or a cancel) stopped the query. */
  queryCanceled: '57014',
} as const;

/** The SQLSTATE of a database error. Drizzle wraps the driver error, so look at `cause` too. */
export function pgCode(error: unknown): string | undefined {
  const read = (candidate: unknown): string | undefined =>
    typeof candidate === 'object' &&
    candidate !== null &&
    'code' in candidate &&
    typeof candidate.code === 'string'
      ? candidate.code
      : undefined;
  const direct = read(error);
  if (direct !== undefined) return direct;
  return typeof error === 'object' && error !== null && 'cause' in error
    ? read(error.cause)
    : undefined;
}

export function isPgError(error: unknown, code: string): boolean {
  return pgCode(error) === code;
}

/** The name of the constraint a database error is about, when the driver says. */
export function pgConstraint(error: unknown): string | undefined {
  const read = (candidate: unknown): string | undefined =>
    typeof candidate === 'object' &&
    candidate !== null &&
    'constraint' in candidate &&
    typeof candidate.constraint === 'string'
      ? candidate.constraint
      : undefined;
  const direct = read(error);
  if (direct !== undefined) return direct;
  return typeof error === 'object' && error !== null && 'cause' in error
    ? read(error.cause)
    : undefined;
}
