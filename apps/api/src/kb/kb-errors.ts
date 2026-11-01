import { pgCode } from '@watchtower/db';

/**
 * A search that failed in the database. A Drizzle error message carries the whole statement and
 * its parameters, and the parameters of a knowledge base search are the customer's own words, so
 * this error carries the SQLSTATE and nothing else (no message of the original, no `cause`): what
 * the application log prints is a code, never text typed by a customer (N4).
 */
export class KbSearchError extends Error {
  override readonly name = 'KbSearchError';

  constructor(error: unknown) {
    const code = pgCode(error);
    super(`Knowledge base search failed${code === undefined ? '' : ` (SQLSTATE ${code})`}`);
  }
}

/** What may be logged about an error whose message could hold query parameters: its class and SQLSTATE. */
export function safeErrorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = pgCode(error);
  return code === undefined ? name : `${name} (SQLSTATE ${code})`;
}
