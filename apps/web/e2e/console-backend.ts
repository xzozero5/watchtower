import type { Role } from '@watchtower/shared';
import type { Page } from '@playwright/test';

import {
  auditEntry,
  CALENDAR,
  CONTACT,
  dueTicket,
  FULL_INTENTS,
  makeAutonomy,
  ORG,
  PEOPLE,
  POLICY,
  QUEUE,
  STATS,
  USERS,
} from '../src/test/console-fixtures';
import { uuid } from '../src/test/fixtures';

import { type BackendOptions, mockBackend } from './backend';

const AT = '2026-11-02T03:00:00.000Z';
type Routes = NonNullable<BackendOptions['routes']>;

export interface ConsoleState {
  killOn: boolean;
  capOn: boolean;
  killReason: string;
  stage: Record<string, number>;
}

/**
 * The head console's reads and writes, kept in memory so a flip shows in the next read, as the api
 * would. Invented names and example.com only (N1).
 */
export async function mockConsole(page: Page, role: Role = 'head', overrides: Routes = {}) {
  const state: ConsoleState = {
    killOn: false,
    capOn: false,
    killReason: '',
    stage: { [uuid(700)]: 1, [uuid(701)]: 2, [uuid(702)]: 2, [uuid(703)]: 0 },
  };
  const autonomy = () => {
    const base = makeAutonomy();
    return {
      ...base,
      switches: [
        {
          key: 'ai_stage_cap_pinned' as const,
          on: state.capOn,
          reason: state.capOn ? 'eval regression' : '',
          changedBy: state.capOn ? PEOPLE.mana.id : null,
          changedByName: state.capOn ? 'Mana' : null,
          changedAt: AT,
        },
        {
          key: 'ai_kill_switch' as const,
          on: state.killOn,
          reason: state.killReason,
          changedBy: state.killReason ? PEOPLE.head.id : null,
          changedByName: state.killReason ? 'Alex' : null,
          changedAt: new Date().toISOString(),
        },
      ],
      intents: base.intents.map((intent) => ({
        ...intent,
        stage: state.stage[intent.id] ?? intent.stage,
        effectiveStage: state.stage[intent.id] ?? intent.effectiveStage,
      })),
    };
  };
  const intentRoutes: Routes = {};
  for (const id of Object.keys(state.stage)) {
    intentRoutes[`POST /v1/intents/${id}/autonomy`] = (request) => {
      const body = request.body as { stage?: number; reason: string };
      if (body.stage !== undefined) state.stage[id] = body.stage;
      const intent = autonomy().intents.find((item) => item.id === id);
      return { json: { changed: true, intent } };
    };
  }

  const backend = await mockBackend(page, {
    role,
    tickets: [
      dueTicket(1, 30, { priority: 'P1' }),
      dueTicket(2, -10, { priority: 'P2', assignee: { id: PEOPLE.mana.id, name: 'Mana K.' } }),
    ],
    routes: {
      'GET /health/ready': () => ({
        json: { status: 'ok', checks: { database: { status: 'up' }, redis: { status: 'up' } } },
      }),
      'GET /v1/tickets/stats': () => ({ json: STATS }),
      'GET /v1/autonomy': () => ({ json: autonomy() }),
      'POST /v1/autonomy/switches': (request) => {
        const body = request.body as { switch: string; on: boolean; reason: string };
        if (body.switch === 'ai_kill_switch') {
          state.killOn = body.on;
          state.killReason = body.reason;
        } else {
          state.capOn = body.on;
        }
        return { json: { changed: true, switches: autonomy().switches } };
      },
      ...intentRoutes,
      'GET /v1/intents': () => ({ json: { intents: FULL_INTENTS } }),
      'GET /v1/queues': () => ({ json: { queues: [QUEUE] } }),
      'GET /v1/users': () => ({ json: { users: USERS } }),
      'GET /v1/sla-policies': () => ({ json: { policies: [POLICY] } }),
      'GET /v1/business-calendars': () => ({ json: { calendars: [CALENDAR] } }),
      [`GET /v1/business-calendars/${CALENDAR.id}`]: () => ({ json: CALENDAR }),
      'GET /v1/org-tiers': () => ({
        json: { tiers: [{ slug: 'gold', name: 'Gold', sortOrder: 1 }] },
      }),
      'GET /v1/orgs': () => ({ json: { items: [ORG], nextCursor: null } }),
      [`GET /v1/orgs/${ORG.id}`]: () => ({ json: ORG }),
      'GET /v1/contacts': () => ({ json: { items: [CONTACT], nextCursor: null } }),
      'GET /v1/audit-logs': () => ({
        json: {
          entries: [
            auditEntry(1),
            auditEntry(2, { action: 'autonomy.switch_set', targetType: 'ai_switch' }),
            auditEntry(3, { outcome: 'denied', action: 'authz.denied', actorId: PEOPLE.pim.id }),
          ],
          nextCursor: null,
        },
      }),
      [`GET /v1/intents/${uuid(700)}/autonomy/history`]: () => ({
        json: {
          items: [
            {
              id: uuid(1100),
              intentId: uuid(700),
              change: 'stage',
              fromStage: 0,
              toStage: 1,
              pinned: false,
              reason: 'eval run passed',
              changedBy: PEOPLE.mana.id,
              changedByName: 'Mana',
              changedAt: AT,
            },
          ],
          nextCursor: null,
        },
      }),
      ...overrides,
    },
  });
  return { ...backend, state };
}
