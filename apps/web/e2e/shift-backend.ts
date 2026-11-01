import type { Role } from '@watchtower/shared';
import type { Page } from '@playwright/test';

import { makeTicket, uuid } from '../src/test/fixtures';
import {
  blocker,
  currentHandoff,
  handoff,
  handoffItem,
  incomingHandoffs,
  offShiftStatus,
  rosterEntry,
  shiftDefinition,
  SHIFT_TZ,
  assignee,
  shiftBrief,
  shiftOverview,
  shiftSession,
  shiftStatus,
  ticketFor,
  WHO,
} from '../src/test/shift-fixtures';

import { type BackendOptions, mockBackend } from './backend';

type Routes = NonNullable<BackendOptions['routes']>;

interface DraftItem {
  id: string;
  nextAction: string;
}

export interface ShiftBackendOptions {
  role?: Role;
  /**
   * The status endpoint says the gate is open although it is not: the person sees an enabled Clock
   * out button and the api refuses it with 409 `handoff_incomplete` (a status that went stale).
   */
  staleStatus?: boolean;
  /** Items the previous shift handed to the person, for the acknowledgment flow. */
  incoming?: number;
  overrides?: Routes;
}

/** The ticket the person holds at P1: it must be in the handoff with a next action before clock out (AC-7). */
export const OPEN_P1 = { id: ticketFor(1).id, key: ticketFor(1).key };
const HANDOFF_ID = handoff().id;

/**
 * The shift screens' api, kept in memory so each write shows in the next read, as the api would:
 * the gate (AC-7) is computed from the handoff state, `clock-out` and `confirm` refuse with 409 and
 * the blockers while it is closed, and the lead view counts the items nobody has answered.
 * Invented names and example.com only (N1).
 */
export async function mockShift(page: Page, options: ShiftBackendOptions = {}) {
  const role = options.role ?? 'agent';
  const state = {
    clockedOut: false,
    drafting: false,
    confirmed: false,
    items: [] as DraftItem[],
    version: 0,
    acked: new Set<string>(),
  };
  const incomingItems = Array.from({ length: options.incoming ?? 0 }, (_, index) =>
    handoffItem(10 + index),
  );

  const gate = () => {
    const found = state.items.find((item) => item.id === OPEN_P1.id);
    const blockers = !state.drafting
      ? [blocker(1, { ticketId: OPEN_P1.id, key: OPEN_P1.key, reason: 'not_listed' })]
      : found === undefined
        ? [blocker(1, { ticketId: OPEN_P1.id, key: OPEN_P1.key, reason: 'not_listed' })]
        : found.nextAction.trim() === ''
          ? [blocker(1, { ticketId: OPEN_P1.id, key: OPEN_P1.key })]
          : [];
    return { noConfirmedHandoff: !state.confirmed, blockers };
  };
  const gateOpen = () => !gate().noConfirmedHandoff && gate().blockers.length === 0;

  const handoffBody = () =>
    handoff({
      status: state.confirmed ? 'confirmed' : 'draft',
      confirmedAt: state.confirmed ? '2026-11-02T03:00:00.000Z' : null,
      updatedAt: new Date(
        Date.parse('2026-11-02T02:00:00.000Z') + state.version * 60_000,
      ).toISOString(),
      items: state.items.map((item) =>
        handoffItem(1, {
          id: item.id,
          nextAction: item.nextAction === '' ? null : item.nextAction,
        }),
      ),
    });

  const session = () =>
    shiftSession({ clockedOutAt: state.clockedOut ? '2026-11-02T03:00:00.000Z' : null });
  const items = () =>
    incomingItems.map((item) =>
      state.acked.has(item.id) ? { ...item, ackStatus: 'accepted' as const, ackBy: WHO.me } : item,
    );
  const pendingAcks = () => incomingItems.filter((item) => !state.acked.has(item.id)).length;

  const ackRoutes: Routes = {};
  for (const item of incomingItems) {
    ackRoutes[`POST /v1/handoffs/items/${item.id}/ack`] = () => {
      state.acked.add(item.id);
      return { json: { ...item, ackStatus: 'accepted', ackBy: WHO.me, warnings: [] } };
    };
  }

  const refusal = () => ({
    status: 409,
    json: {
      statusCode: 409,
      error: 'Conflict',
      code: 'handoff_incomplete',
      message: 'handoff_incomplete',
      ...gate(),
    },
  });

  const backend = await mockBackend(page, {
    role,
    tickets: [makeTicket(1, { subject: 'Cannot log in', priority: 'P1' })],
    routes: {
      'GET /v1/shifts/status': () => ({
        json: state.clockedOut
          ? offShiftStatus()
          : shiftStatus({
              session: session(),
              handoff: state.drafting
                ? { id: HANDOFF_ID, status: state.confirmed ? 'confirmed' : 'draft' }
                : null,
              clockOutBlocked: options.staleStatus || gateOpen() ? null : gate(),
              pendingAcks: pendingAcks(),
            }),
      }),
      'POST /v1/shifts/clock-out': () => {
        if (!gateOpen()) return refusal();
        state.clockedOut = true;
        return { json: { session: session(), overridden: false } };
      },
      'GET /v1/handoffs/current': () => ({
        json: currentHandoff({
          handoff: state.drafting ? handoffBody() : null,
          gate: gate(),
        }),
      }),
      'POST /v1/handoffs/prefill': () => {
        if (!state.drafting) {
          state.drafting = true;
          state.items = [{ id: OPEN_P1.id, nextAction: '' }];
          // The item id is the ticket id here only to keep the mock small.
        }
        return { json: handoffBody() };
      },
      [`PUT /v1/handoffs/${HANDOFF_ID}`]: (request) => {
        const body = request.body as { items: { id?: string; nextAction: string | null }[] };
        state.items = body.items.map((item, index) => ({
          id: item.id ?? uuid(3600 + index),
          nextAction: item.nextAction ?? '',
        }));
        state.version += 1;
        return { json: handoffBody() };
      },
      [`POST /v1/handoffs/${HANDOFF_ID}/confirm`]: () => {
        const current = gate();
        if (current.blockers.length > 0) return refusal();
        state.confirmed = true;
        state.version += 1;
        return { json: handoffBody() };
      },
      'GET /v1/shifts/brief': () => ({
        json: shiftBrief({
          session: session(),
          handoff: incomingHandoffs(items()),
        }),
      }),
      'GET /v1/handoffs/incoming': () => ({ json: incomingHandoffs(items()) }),
      'GET /v1/shifts/overview': () => ({
        json: shiftOverview({
          unacknowledged: {
            count: pendingAcks(),
            overdue: 0,
            items: incomingItems
              .filter((item) => !state.acked.has(item.id))
              .map((item) => ({
                itemId: item.id,
                handoffId: uuid(3901),
                title: item.title,
                ticketKey: item.ticket?.key ?? null,
                from: WHO.mana,
                confirmedAt: '2026-11-02T02:00:00.000Z',
                overdue: false,
              })),
          },
        }),
      }),
      'GET /v1/shifts/definitions': () => ({
        json: { timezone: SHIFT_TZ, definitions: [shiftDefinition(0), shiftDefinition(1)] },
      }),
      'GET /v1/roster': () => ({
        json: { timezone: SHIFT_TZ, entries: [rosterEntry(1, { workDate: '2026-11-02' })] },
      }),
      'GET /v1/assignees': () => ({
        json: {
          assignees: [assignee(WHO.me), assignee(WHO.pim), assignee(WHO.dao, { onShift: false })],
        },
      }),
      'GET /v1/shift-notes': () => ({ json: { items: [], nextCursor: null, unreadCount: 0 } }),
      ...ackRoutes,
      ...options.overrides,
    },
  });
  return { ...backend, state };
}
