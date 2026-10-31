import { OPEN_STATUSES } from '@watchtower/shared';

import type { TicketItem } from './model';

/** UI SLA states, docs/06-UI-SPEC.md section 4.4. */
export type SlaState = 'onTrack' | 'atRisk' | 'breached' | 'paused' | 'met' | 'none';
export type SlaTarget = 'firstResponse' | 'resolution';

export interface SlaView {
  state: SlaState;
  /** The next target the clock is running towards; null for `met` and `none`. */
  target: SlaTarget | null;
  /** Time left (on track, at risk, paused) or time past due (breached), in ms, never negative. */
  ms: number;
  dueAt: string | null;
}

/** `[ASSUMED]` thresholds from the spec: at risk at 25% of the target left, or 30 minutes. */
export const AT_RISK_FRACTION = 0.25;
export const AT_RISK_MS = 30 * 60_000;

const NONE: SlaView = { state: 'none', target: null, ms: 0, dueAt: null };

/**
 * The SLA badge of a ticket: shows the next due target (first response until the ticket is
 * answered, then resolution). The length of the target is taken as due time minus creation time,
 * which ignores business-hours gaps, so "at risk" can come a little early or late `[ASSUMED]`.
 */
export function slaView(ticket: TicketItem, now: number): SlaView {
  // A customer's view of a ticket carries no SLA fields.
  if (!('channel' in ticket)) return NONE;

  const waitingFirst = ticket.firstRespondedAt === null && ticket.firstResponseDueAt !== null;
  const waitingResolution =
    !waitingFirst &&
    ticket.resolvedAt === null &&
    ticket.resolutionDueAt !== null &&
    OPEN_STATUSES.includes(ticket.status);

  const target: SlaTarget | null = waitingFirst
    ? 'firstResponse'
    : waitingResolution
      ? 'resolution'
      : null;
  const dueAt = waitingFirst
    ? ticket.firstResponseDueAt
    : waitingResolution
      ? ticket.resolutionDueAt
      : null;

  if (target === null || dueAt === null) {
    const achieved = ticket.firstRespondedAt !== null || ticket.resolvedAt !== null;
    return achieved ? { state: 'met', target: null, ms: 0, dueAt: null } : NONE;
  }

  const left = Date.parse(dueAt) - now;
  if (ticket.slaPausedAt !== null) {
    return { state: 'paused', target, ms: Math.max(0, left), dueAt };
  }
  if (left < 0) return { state: 'breached', target, ms: -left, dueAt };

  const total = Date.parse(dueAt) - Date.parse(ticket.createdAt);
  const atRisk = left <= AT_RISK_MS || (total > 0 && left <= total * AT_RISK_FRACTION);
  return { state: atRisk ? 'atRisk' : 'onTrack', target, ms: left, dueAt };
}
