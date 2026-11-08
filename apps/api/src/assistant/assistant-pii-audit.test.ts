import type { Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import {
  PII_KINDS,
  TOOL_PERMISSION,
  type AssistantToolName,
  type PiiKind,
} from './assistant-access.js';
import { buildAssistantTools, type AssistantToolDeps } from './assistant-tools.js';

const USER_ID = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';
const OTHER_ID = '9a7d1f0e-3b3c-4d52-8f10-5c1a2b3c4d5e';
const TICKET_ID = '00000000-0000-4000-8000-000000000012';
const HANDOFF_ID = '11111111-1111-4000-8000-000000000001';
const NOTE_ID = '22222222-2222-4000-8000-000000000002';
const ROSTER_ID = '33333333-3333-4000-8000-000000000003';
const INCIDENT_ID = '44444444-4444-4000-8000-000000000004';
const CONV_ID = '55555555-5555-4000-8000-000000000005';
const SESSION_ID = '66666666-6666-4000-8000-000000000006';

const ALL_PERMISSIONS: Permission[] = [
  'ticket.read',
  'ticket.handle',
  'ticket.create',
  'kb.read',
  'investigate.run',
  'dashboard.ops.read',
  'performance.read.all',
  'inbound.read',
  'handoff.write',
  'handoff.ack',
  'shift.clock',
  'shift.note.write',
  'roster.manage',
  'alert.read',
];

const makePrincipal = (
  role = 'lead',
  permissions: readonly Permission[] = ALL_PERMISSIONS,
  userId = USER_ID,
) =>
  ({
    userId,
    sessionId: 'session-1',
    role,
    permissions: new Set(permissions),
    orgScope: { kind: 'all' },
    email: 'ops@example.com',
    name: 'Ops Lead',
  }) as never;

function buildMockDeps(): { deps: AssistantToolDeps; audited: { kind: PiiKind; id: string }[] } {
  const audited: { kind: PiiKind; id: string }[] = [];
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () =>
          Object.assign([{ id: USER_ID, name: 'Mali' }], {
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
            limit: () => Promise.resolve([{ name: 'Jane Doe' }]),
          }),
      }),
    }),
  };

  const moduleServices = {
    reader: {
      viewRow: () =>
        Promise.resolve({
          t: { id: TICKET_ID, number: 12, orgId: 'org-1', status: 'open', priority: 'P2' },
          orgName: 'Acme',
          assigneeName: 'Mali',
        } as never),
    },
    dashboard: {
      ops: () =>
        Promise.resolve({
          window: { from: '2026-11-01', to: '2026-11-08', days: 7 },
          queue: { open: 5, unassigned: 2, paused: 1, breachedNow: 1, atRiskNow: 2, byStatus: {} },
          volume: { created: 40, previous: { created: 30, from: '', to: '' } },
          sla: {
            firstResponse: {
              status: 'ok',
              data: { medianSeconds: 600, p90Seconds: 1800, samples: 30 },
            },
            resolution: { status: 'not_available', reason: 'no_data' },
            firstResponseBreach: { status: 'ok', data: { evaluated: 30, breached: 3, rate: 0.1 } },
            resolutionBreach: { status: 'restricted', requires: 'x' },
          },
          reliability: { incidents: { started: 2, openNow: 1, open: [] }, alerts: { openNow: 3 } },
        }),
      performance: () =>
        Promise.resolve({
          window: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-08T00:00:00.000Z', days: 7 },
          scope: 'all' as const,
          agents: [
            {
              userId: USER_ID,
              name: 'Mali',
              open: 12,
              resolved: 10,
            },
          ],
        }),
    } as never,
    otherMail: {
      list: () =>
        Promise.resolve({
          items: [
            {
              id: CONV_ID,
              channel: 'email',
              disposition: 'noise' as const,
              fromName: 'Jane Customer',
              fromAddress: 'customer@example.com',
              subject: 'Help required',
              snippet: 'Cannot access my account',
              receivedAt: '2026-11-08T00:00:00.000Z',
            },
          ],
          total: 1,
        }),
      get: () =>
        Promise.resolve({
          id: CONV_ID,
          channel: 'email',
          disposition: 'noise' as const,
          fromName: 'Jane Customer',
          fromAddress: 'customer@example.com',
          subject: 'Help required',
          snippet: 'Cannot access my account',
          bodyText: 'Cannot access my account. Please help.',
          receivedAt: '2026-11-08T00:00:00.000Z',
        }),
    } as never,
    timeline: {
      timeline: () =>
        Promise.resolve({
          entries: [
            {
              id: '11111111-1111-4000-8000-000000000050',
              ticketKey: 'OPS-12',
              type: 'status_changed',
              actor: { type: 'user', name: 'Mali' },
              payload: { from: 'open', to: 'pending' },
              createdAt: '2026-11-08T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
    } as never,
    kb: {
      get: () =>
        Promise.resolve({
          id: 'kb-1',
          title: 'Reset Password',
          section: 'Auth',
          body: 'Click forgot password',
          publishedAt: '2026-11-01',
        }),
    } as never,
    handoffs: {
      current: () =>
        Promise.resolve({
          handoff: {
            id: HANDOFF_ID,
            status: 'draft',
            from: { id: USER_ID, name: 'Ops Lead' },
            to: null,
            notes: 'Smooth shift',
            messageForNext: 'Check ticket 12',
            items: [
              {
                id: '11111111-1111-4000-8000-000000000099',
                kind: 'ticket',
                title: 'High priority issue',
                nextAction: 'Investigate',
                ackStatus: 'pending',
                carriedShifts: 0,
                dueAt: null,
                ticket: {
                  id: TICKET_ID,
                  key: 'OPS-12',
                  priority: 'P1',
                  status: 'open',
                  assignee: { name: 'Mali' },
                },
              },
            ],
          },
        }),
      incoming: () =>
        Promise.resolve({
          total: 1,
          acknowledged: 0,
          handoffs: [
            {
              id: HANDOFF_ID,
              status: 'confirmed',
              from: { id: OTHER_ID, name: 'Alice' },
              to: { id: USER_ID, name: 'Ops Lead' },
              notes: 'Night shift notes',
              messageForNext: 'All clean',
              items: [
                {
                  id: '11111111-1111-4000-8000-000000000098',
                  kind: 'ticket',
                  title: 'Pending ticket',
                  nextAction: 'Follow up',
                  ackStatus: 'pending',
                  carriedShifts: 1,
                  dueAt: null,
                  ticket: {
                    id: TICKET_ID,
                    key: 'OPS-12',
                    priority: 'P2',
                    status: 'open',
                    assignee: { name: 'Alice' },
                  },
                },
              ],
            },
          ],
        }),
    } as never,
    organizations: {
      get: () => Promise.resolve({ id: 'org-1', name: 'Acme', tier: 'enterprise' }),
    } as never,
    intentDetail: {
      get: () => Promise.resolve({ id: 'intent-1', name: 'Auth', key: 'auth_issue' }),
    } as never,
    catalog: {
      getService: () => Promise.resolve({ id: 'service-1', name: 'Auth Service', status: 'ok' }),
    } as never,
    sla: {
      listPolicies: () => Promise.resolve([]),
    } as never,
    autonomy: {
      read: () => Promise.resolve({ intents: [] }),
      promotionState: () => Promise.resolve({}),
    } as never,
  };

  const deps: AssistantToolDeps = {
    database: { db: fakeDb } as never,
    readOnly: (work) => work(fakeDb as never),
    readOnlyScope: (work) => work(),
    reader: {
      viewRow: () =>
        Promise.resolve({
          t: {
            id: TICKET_ID,
            number: 12,
            subject: 'Cannot sign in',
            status: 'open',
            priority: 'P2',
            orgId: 'org-1',
            updatedAt: new Date(),
          },
          orgName: 'Acme',
          assigneeName: 'Mali',
          requesterName: 'Jane Doe',
          intentKey: 'access_issue',
          intentName: 'Access problems',
          aiSummary: 'Customer cannot sign in.',
        }),
      list: () =>
        Promise.resolve({
          items: [
            {
              id: TICKET_ID,
              key: 'OPS-12',
              subject: 'Cannot sign in',
              status: 'open',
              priority: 'P2',
              org: { id: 'org-1', name: 'Acme' },
              assignee: { id: USER_ID, name: 'Mali' },
              sla: { state: 'at_risk' },
            },
          ],
          nextCursor: null,
        }),
      stats: () =>
        Promise.resolve({
          byAssignee: [
            {
              assigneeId: USER_ID,
              count: 14,
              open: 12,
              sla: { ok: 8, at_risk: 2, breached: 2, paused: 0 },
            },
            {
              assigneeId: null,
              count: 3,
              open: 3,
              sla: { ok: 3, at_risk: 0, breached: 0, paused: 0 },
            },
          ],
        }),
    } as never,
    keys: { format: (n: number) => `OPS-${String(n)}` } as never,
    sla: {
      view: () =>
        Promise.resolve({
          target: 'resolution',
          state: 'at_risk',
          dueAt: '2026-11-08T08:00:00.000Z',
          calendar: 'business',
          minutesLeft: 45,
        }),
    } as never,
    kb: {
      search: () => Promise.resolve({ mode: 'hybrid', hits: [] }),
    } as never,
    brief: {
      assignees: () =>
        Promise.resolve({
          assignees: [
            {
              id: USER_ID,
              name: 'Mali',
              role: 'agent',
              onShift: true,
              openTickets: 4,
              inQueue: false,
            },
          ],
        }),
    } as never,
    runner: {
      ticketSubject: () => Promise.resolve({ kind: 'ticket', ticketId: TICKET_ID, orgId: 'org-1' }),
      aiTemplateOf: () => Promise.resolve('tpl-1'),
      runForAssistant: () =>
        Promise.resolve({
          kind: 'logs',
          title: 'Recent auth errors',
          summary: 'Found 4 500s',
          excerpt: 'error: failed auth',
          resultCount: 4,
          mock: false,
        }),
    } as never,
    embeddingMock: true,
    aiMock: true,
    incidents: {
      idOfNumber: () => Promise.resolve(INCIDENT_ID),
      get: () =>
        Promise.resolve({
          id: INCIDENT_ID,
          key: 'INC-1',
          number: 1,
          title: 'Major Outage',
          status: 'investigating',
          severity: 'SEV1',
          startedAt: '2026-11-08T00:00:00.000Z',
          resolvedAt: null,
          tickets: 1,
          alerts: 0,
          rootCause: 'Database failover',
          orgIds: ['org-1'],
          ticketIds: [TICKET_ID],
          alertIds: [],
          timeline: [
            {
              id: '11111111-1111-4000-8000-000000000051',
              type: 'note',
              actorType: 'user',
              payload: { text: 'Incident note' },
              createdAt: '2026-11-08T00:00:00.000Z',
            },
          ],
        }),
      changes: () => Promise.resolve({ deploys: [] }),
    } as never,
    alerts: {
      search: () => Promise.resolve({ items: [] }),
      get: () => Promise.resolve({ id: 'alt-1', name: 'High CPU' }),
    } as never,
    statusAdmin: {
      components: () => Promise.resolve([]),
      posts: () => Promise.resolve([]),
    } as never,
    handoffs: moduleServices.handoffs,
    shiftNotes: {
      list: () =>
        Promise.resolve({
          unreadCount: 1,
          items: [
            {
              id: NOTE_ID,
              author: { id: OTHER_ID, name: 'Alice' },
              audience: 'team',
              body: 'Remember to check night logs',
              createdAt: '2026-11-08T00:00:00.000Z',
              readAt: null,
            },
          ],
        }),
    } as never,
    shifts: {
      status: () =>
        Promise.resolve({
          session: {
            id: SESSION_ID,
            shiftName: 'Morning Shift',
            clockedOutAt: null,
            scheduledEnd: '2026-11-08T16:00:00.000Z',
          },
          minutesToEnd: 120,
          unreadNotes: 1,
          pendingAcks: 1,
          handoff: { status: 'draft' },
        }),
      roster: () =>
        Promise.resolve({
          timezone: 'Asia/Bangkok',
          entries: [
            {
              id: ROSTER_ID,
              shiftName: 'Morning Shift',
              onCall: false,
              userName: 'Mali',
              workDate: '2026-11-08',
              startsAt: '08:00',
              endsAt: '16:00',
            },
          ],
        }),
    } as never,
    modules: moduleServices as never,
  };

  return { deps, audited };
}

describe('T-445b C-17 PII Audit Catalogue and Withhold', () => {
  it('covers all PII kinds declared in ADR-029 C-17 catalogue', () => {
    expect(PII_KINDS).toEqual([
      'ticket',
      'conversation',
      'contact',
      'timeline',
      'shift_overview',
      'performance',
      'handoff',
      'shift_note',
      'roster',
    ]);
  });

  it('declares piiKinds for every tool that accesses personal or staff data', () => {
    expect(TOOL_PERMISSION.search_tickets.piiKinds).toContain('ticket');
    expect(TOOL_PERMISSION.summarize_ticket.piiKinds).toContain('ticket');
    expect(TOOL_PERMISSION.explain_sla.piiKinds).toContain('ticket');
    expect(TOOL_PERMISSION.team_load.piiKinds).toContain('performance');
    expect(TOOL_PERMISSION.team_status.piiKinds).toContain('shift_overview');
    expect(TOOL_PERMISSION.investigate_run.piiKinds).toContain('ticket');
    expect(TOOL_PERMISSION.incident_get.piiKinds).toEqual(['ticket', 'timeline']);
    expect(TOOL_PERMISSION.shift_context.piiKinds).toEqual([
      'ticket',
      'shift_overview',
      'handoff',
      'shift_note',
    ]);
    expect(TOOL_PERMISSION.roster_view.piiKinds).toEqual(['roster']);
    expect(TOOL_PERMISSION.performance_view.piiKinds).toContain('performance');
    expect(TOOL_PERMISSION.conversation_search.piiKinds).toContain('conversation');
    expect(TOOL_PERMISSION.conversation_get.piiKinds).toContain('conversation');
    expect(TOOL_PERMISSION.ticket_timeline.piiKinds).toEqual(['ticket', 'timeline']);
    expect(TOOL_PERMISSION.handoff_get.piiKinds).toEqual(['ticket', 'handoff']);
    expect(TOOL_PERMISSION.handoff_incoming_get.piiKinds).toEqual(['ticket', 'handoff']);
  });

  describe('No-Chip invocations emit onPiiAudit for every entity read', () => {
    async function testToolAudit(
      toolName: AssistantToolName,
      input: unknown,
      expectedKinds: PiiKind[],
    ) {
      const { deps, audited } = buildMockDeps();
      const principal = makePrincipal();
      const host = buildAssistantTools(deps, {
        principal,
        locale: 'en',
        masked: false,
        now: new Date(),
        onPiiAudit: (entry) => {
          audited.push(entry);
          return Promise.resolve();
        },
      });

      const output = await host.tools.call(toolName, input);
      expect(output).toBeDefined();
      expect(audited.length).toBeGreaterThan(0);
      for (const expectedKind of expectedKinds) {
        expect(audited.some((a) => a.kind === expectedKind)).toBe(true);
      }
    }

    it('team_status records shift_overview on no-chip call', async () => {
      await testToolAudit('team_status', {}, ['shift_overview']);
    });

    it('team_load records performance on no-chip call', async () => {
      await testToolAudit('team_load', {}, ['performance']);
    });

    it('roster_view records roster on no-chip call', async () => {
      await testToolAudit('roster_view', {}, ['roster']);
    });

    it('shift_context records handoff, shift_note, and shift_overview on no-chip call', async () => {
      await testToolAudit('shift_context', { section: 'all' }, [
        'handoff',
        'shift_note',
        'shift_overview',
      ]);
    });

    it('search_tickets records ticket on no-chip query', async () => {
      await testToolAudit('search_tickets', { query: 'login' }, ['ticket']);
    });

    it('summarize_ticket records ticket on no-chip call', async () => {
      await testToolAudit('summarize_ticket', { ticket: 'OPS-12' }, ['ticket']);
    });

    it('explain_sla records ticket on no-chip call', async () => {
      await testToolAudit('explain_sla', { ticket: 'OPS-12' }, ['ticket']);
    });

    it('investigate_run records ticket on no-chip call', async () => {
      await testToolAudit('investigate_run', { ticket: 'OPS-12' }, ['ticket']);
    });

    it('conversation_search records conversation on no-chip call', async () => {
      await testToolAudit('conversation_search', {}, ['conversation']);
    });

    it('conversation_get records conversation', async () => {
      await testToolAudit('conversation_get', { id: CONV_ID }, ['conversation']);
    });

    it('performance_view records performance on no-chip call', async () => {
      await testToolAudit('performance_view', {}, ['performance']);
    });

    it('ticket_timeline records ticket and timeline on no-chip call', async () => {
      await testToolAudit('ticket_timeline', { ticket: 'OPS-12' }, ['ticket', 'timeline']);
    });

    it('handoff_get records handoff and ticket', async () => {
      await testToolAudit('handoff_get', { id: HANDOFF_ID }, ['handoff', 'ticket']);
    });

    it('handoff_incoming_get records handoff and ticket', async () => {
      await testToolAudit('handoff_incoming_get', { id: HANDOFF_ID }, ['handoff', 'ticket']);
    });

    it('incident_get records timeline and ticket', async () => {
      await testToolAudit('incident_get', { incident: 'INC-1' }, ['timeline', 'ticket']);
    });
  });

  describe('Fail-Closed Withhold Mechanism', () => {
    it('withholds tool output and throws immediately when onPiiAudit rejects', async () => {
      const { deps } = buildMockDeps();
      const principal = makePrincipal();
      const auditError = new Error('Database disk full: audit log write failure');

      const host = buildAssistantTools(deps, {
        principal,
        locale: 'en',
        masked: false,
        now: new Date(),
        onPiiAudit: () => Promise.reject(auditError),
      });

      // Calling team_status must throw and NOT return any members
      await expect(host.tools.call('team_status', {})).rejects.toThrow(auditError);

      // Calling team_load must throw and NOT return any rows
      await expect(host.tools.call('team_load', {})).rejects.toThrow(auditError);

      // Calling search_tickets must throw and NOT return any tickets
      await expect(host.tools.call('search_tickets', { query: 'test' })).rejects.toThrow(
        auditError,
      );

      // Calling shift_context must throw and NOT return handoff/notes
      await expect(host.tools.call('shift_context', { section: 'all' })).rejects.toThrow(
        auditError,
      );

      // Calling roster_view must throw and NOT return schedule
      await expect(host.tools.call('roster_view', {})).rejects.toThrow(auditError);

      // Calling conversation_search must throw and NOT return messages
      await expect(host.tools.call('conversation_search', {})).rejects.toThrow(auditError);
    });

    it('does not produce facts when tool call fails audit', async () => {
      const { deps } = buildMockDeps();
      const principal = makePrincipal();
      let outputCaptured: unknown = undefined;

      const host = buildAssistantTools(deps, {
        principal,
        locale: 'en',
        masked: false,
        now: new Date(),
        onPiiAudit: () => Promise.reject(new Error('Audit service unavailable')),
      });

      try {
        outputCaptured = await host.tools.call('team_status', {});
      } catch {
        // Expected failure
      }

      expect(outputCaptured).toBeUndefined();
      // Facts generator cannot be invoked without output
    });
  });
});
