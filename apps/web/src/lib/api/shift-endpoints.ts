import {
  ackResultSchema,
  assigneeListSchema,
  clockOutResultSchema,
  currentHandoffSchema,
  handoffSchema,
  incomingHandoffsSchema,
  rosterEntrySchema,
  rosterListSchema,
  shiftBriefSchema,
  shiftDefinitionListSchema,
  shiftDefinitionSchema,
  shiftNotePageSchema,
  shiftNoteSchema,
  shiftOverviewSchema,
  shiftSessionSchema,
  shiftStatusSchema,
  type AckHandoffItem,
  type AssigneeQuery,
  type ClockIn,
  type ClockOut,
  type CreateRosterEntry,
  type CreateShiftDefinition,
  type CreateShiftNote,
  type SaveHandoff,
  type UpdateShiftDefinition,
} from '@watchtower/shared';

import type { ApiClient } from './client';

const withSignal = (signal?: AbortSignal) => (signal ? { signal } : {});

/** The shift, roster, handoff, note and brief endpoints (T-111). One function per endpoint. */
export function createShiftEndpoints(client: ApiClient) {
  const id = (value: string) => encodeURIComponent(value);

  return {
    // --- clock in and out ---
    shiftStatus: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/shifts/status',
        schema: shiftStatusSchema,
        ...withSignal(signal),
      }),

    clockIn: (body: ClockIn) =>
      client.request({
        method: 'POST',
        path: '/v1/shifts/clock-in',
        body,
        schema: shiftSessionSchema,
      }),

    /** A 409 `handoff_incomplete` carries `blockers` in `ApiRequestError.details` (AC-7). */
    clockOut: (body: ClockOut) =>
      client.request({
        method: 'POST',
        path: '/v1/shifts/clock-out',
        body,
        schema: clockOutResultSchema,
      }),

    shiftOverview: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/shifts/overview',
        schema: shiftOverviewSchema,
        ...withSignal(signal),
      }),

    // --- brief ---
    shiftBrief: (signal?: AbortSignal) =>
      client.request({ path: '/v1/shifts/brief', schema: shiftBriefSchema, ...withSignal(signal) }),

    markBriefRead: () =>
      client.request({
        method: 'POST',
        path: '/v1/shifts/brief/read',
        schema: shiftSessionSchema,
      }),

    // --- who can be assigned ---
    assignees: (query: AssigneeQuery = {}, signal?: AbortSignal) =>
      client.request({
        path: '/v1/assignees',
        query: { queueId: query.queueId },
        schema: assigneeListSchema,
        ...withSignal(signal),
      }),

    // --- definitions and roster ---
    shiftDefinitions: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/shifts/definitions',
        schema: shiftDefinitionListSchema,
        ...withSignal(signal),
      }),

    createShiftDefinition: (body: CreateShiftDefinition) =>
      client.request({
        method: 'POST',
        path: '/v1/shifts/definitions',
        body,
        schema: shiftDefinitionSchema,
      }),

    updateShiftDefinition: (definitionId: string, body: UpdateShiftDefinition) =>
      client.request({
        method: 'PATCH',
        path: `/v1/shifts/definitions/${id(definitionId)}`,
        body,
        schema: shiftDefinitionSchema,
      }),

    roster: (
      query: { from: string; to: string; userId?: string | undefined },
      signal?: AbortSignal,
    ) =>
      client.request({
        path: '/v1/roster',
        query,
        schema: rosterListSchema,
        ...withSignal(signal),
      }),

    addRosterEntry: (body: CreateRosterEntry) =>
      client.request({
        method: 'POST',
        path: '/v1/roster',
        body,
        schema: rosterEntrySchema,
      }),

    removeRosterEntry: (entryId: string) =>
      client.request({
        method: 'DELETE',
        path: `/v1/roster/${id(entryId)}`,
        schema: null,
      }),

    // --- handoff ---
    currentHandoff: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/handoffs/current',
        schema: currentHandoffSchema,
        ...withSignal(signal),
      }),

    prefillHandoff: () =>
      client.request({ method: 'POST', path: '/v1/handoffs/prefill', schema: handoffSchema }),

    saveHandoff: (handoffId: string, body: SaveHandoff) =>
      client.request({
        method: 'PUT',
        path: `/v1/handoffs/${id(handoffId)}`,
        body,
        schema: handoffSchema,
      }),

    /** A 409 `handoff_incomplete` carries `blockers` in `ApiRequestError.details`. */
    confirmHandoff: (handoffId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/handoffs/${id(handoffId)}/confirm`,
        schema: handoffSchema,
      }),

    reopenHandoff: (handoffId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/handoffs/${id(handoffId)}/reopen`,
        schema: handoffSchema,
      }),

    incomingHandoffs: (signal?: AbortSignal) =>
      client.request({
        path: '/v1/handoffs/incoming',
        schema: incomingHandoffsSchema,
        ...withSignal(signal),
      }),

    ackHandoffItem: (itemId: string, body: AckHandoffItem) =>
      client.request({
        method: 'POST',
        path: `/v1/handoffs/items/${id(itemId)}/ack`,
        body,
        schema: ackResultSchema,
      }),

    // --- shift notes ---
    shiftNotes: (
      query: { box: 'inbox' | 'sent'; unread?: boolean; cursor?: string },
      signal?: AbortSignal,
    ) =>
      client.request({
        path: '/v1/shift-notes',
        query: { box: query.box, unread: query.unread, cursor: query.cursor, limit: 50 },
        schema: shiftNotePageSchema,
        ...withSignal(signal),
      }),

    createShiftNote: (body: CreateShiftNote) =>
      client.request({
        method: 'POST',
        path: '/v1/shift-notes',
        body,
        schema: shiftNoteSchema,
      }),

    markShiftNoteRead: (noteId: string) =>
      client.request({
        method: 'POST',
        path: `/v1/shift-notes/${id(noteId)}/read`,
        schema: shiftNoteSchema,
      }),
  };
}
