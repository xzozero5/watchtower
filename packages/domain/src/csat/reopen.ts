import { CSAT_REOPEN_BELOW_SCORE } from '@watchtower/shared';

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a ticket resolved at `resolvedAt` can still be reopened by the customer (R-1.10): within
 * `windowDays` days of the resolve. A ticket with no resolve time cannot.
 */
export function isWithinReopenWindow(
  resolvedAt: Date | null,
  now: Date,
  windowDays: number,
): boolean {
  return resolvedAt !== null && now.getTime() - resolvedAt.getTime() <= windowDays * DAY_MS;
}

export interface CsatReopenInput {
  readonly score: number;
  /** "Was this resolved?"; undefined when the customer did not answer that question. */
  readonly resolved: boolean | undefined;
  readonly ticketStatus: string;
  readonly resolvedAt: Date | null;
  readonly now: Date;
  readonly windowDays: number;
}

export type CsatReopenDecision =
  | { readonly reopen: true; readonly reason: 'low_score' | 'not_resolved' }
  | {
      readonly reopen: false;
      /**
       * `no_trigger`: the answer is fine. `not_resolved_status`: the ticket is not `resolved` any
       * more (already reopened, or closed: a closed ticket is final). `window_closed`: resolved
       * more than `windowDays` days ago.
       */
      readonly reason: 'no_trigger' | 'not_resolved_status' | 'window_closed';
    };

/**
 * R-1.10 and R-10.5: a customer who rates the support below 3 (1 or 2), or says the problem is not
 * resolved, reopens the ticket, but only while it is `resolved` and inside the 7-day window.
 * A low score wins over a "not resolved" answer as the recorded reason.
 */
export function decideCsatReopen(input: CsatReopenInput): CsatReopenDecision {
  const lowScore = input.score < CSAT_REOPEN_BELOW_SCORE;
  const notResolved = input.resolved === false;
  if (!lowScore && !notResolved) return { reopen: false, reason: 'no_trigger' };
  if (input.ticketStatus !== 'resolved') return { reopen: false, reason: 'not_resolved_status' };
  if (!isWithinReopenWindow(input.resolvedAt, input.now, input.windowDays)) {
    return { reopen: false, reason: 'window_closed' };
  }
  return { reopen: true, reason: lowScore ? 'low_score' : 'not_resolved' };
}
