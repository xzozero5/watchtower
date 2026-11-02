/**
 * What a person types to name one ticket: `1003`, `#1003` or `OPS-1003`. The prefix
 * is the instance's own (`TICKET_KEY_PREFIX`); a typed prefix wins so another prefix is not
 * silently rewritten. Anything else (words, two numbers) is not a ticket reference.
 */
const REF_SHAPE = /^#?(?:([A-Za-z][A-Za-z0-9]{0,15})-)?(\d{1,9})$/;

export interface TicketRef {
  /** `OPS-1003`. */
  key: string;
  number: number;
}

export function parseTicketRef(input: string, defaultPrefix: string): TicketRef | null {
  const match = REF_SHAPE.exec(input.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const prefix = (match[1] ?? defaultPrefix).toUpperCase();
  if (prefix === '') return null;
  return { key: `${prefix}-${String(number)}`, number };
}
