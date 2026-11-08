import { DEFAULT_ROLE_PERMISSIONS, type OrgScope, type Permission } from '@watchtower/shared';
import { describe, expect, it } from 'vitest';

import { collectRoutes } from '../testing/route-table.js';
import type { Principal } from '../auth/principal.js';
import {
  TOOL_PERMISSION,
  canUseAssistant,
  isMasked,
  toolsFor,
  type AssistantToolName,
} from './assistant-access.js';
import { buildAssistantTools, type AssistantToolDeps } from './assistant-tools.js';
import type { ModuleReadServices } from './tools/read-services.js';

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const principal = (
  role: string,
  permissions: readonly Permission[],
  userId = CALLER_ID,
  orgScope: OrgScope = { kind: 'all' },
) =>
  ({
    userId,
    role,
    permissions: new Set(permissions),
    orgScope,
  }) as never;

describe('Exhaustive Assistant RBAC Matrix: tool × role (T-410, DoD C-16, AC-J6)', () => {
  describe('Deny-by-default and Client/System rejection (AC-J13)', () => {
    it('gives client, system, and arbitrary roles exactly 0 tools (deny-by-default)', () => {
      // Even if granted permissions, client and system are strictly blocked by role allowlist
      const allPermissions = Object.keys(TOOL_PERMISSION).flatMap((tool) => {
        const entry = TOOL_PERMISSION[tool as AssistantToolName];
        if ('all' in entry.rule) return [...entry.rule.all];
        return [...entry.rule.anyOf];
      });

      for (const role of ['client', 'system', 'nobody', 'guest', 'anonymous', '']) {
        const p = principal(role, allPermissions);
        expect(toolsFor(p), `role "${role}" must get 0 tools`).toEqual([]);
      }
    });

    it('client and system with default permissions cannot use assistant', () => {
      for (const role of ['client', 'system'] as const) {
        const p = principal(role, DEFAULT_ROLE_PERMISSIONS[role]);
        expect(toolsFor(p), `role "${role}" must get 0 tools`).toEqual([]);
        expect(canUseAssistant(p), `role "${role}" canUseAssistant must be false`).toBe(false);
      }
    });

    it('denies tools when user has empty permissions, even for head/lead/agent/dev', () => {
      for (const role of ['head', 'lead', 'agent', 'dev'] as const) {
        const p = principal(role, []);
        expect(toolsFor(p), `role "${role}" with empty permissions must get 0 tools`).toEqual([]);
      }
    });
  });

  describe('Developer role strict masked-read isolation (po #33, AC-J19)', () => {
    it('dev role gets strictly allowed masked tools and never tools requiring ticket.read', () => {
      const devPrincipal = principal('dev', DEFAULT_ROLE_PERMISSIONS.dev);
      expect(isMasked(devPrincipal)).toBe(true);

      const devTools = toolsFor(devPrincipal);
      expect(devTools).toEqual([
        'search_tickets',
        'summarize_ticket',
        'explain_sla',
        'investigate_run',
        'ticket_timeline',
      ]);

      // Dev MUST NOT receive any tools that require full ticket.read without masked
      const fullTicketReadTools: AssistantToolName[] = [
        'incident_search',
        'incident_get',
        'statuspage_status',
        'statuspage_drafts',
        'autonomy_status',
        'config_lookup',
        'org_get',
        'intent_get',
      ];

      for (const tool of fullTicketReadTools) {
        expect(devTools, `dev must not have access to ${tool}`).not.toContain(tool);
      }

      // Dev MUST NOT receive ops management or shift tools
      const opsTools: AssistantToolName[] = [
        'team_load',
        'team_status',
        'shift_context',
        'roster_view',
        'ops_metrics',
        'ceo_metrics',
        'performance_view',
      ];
      for (const tool of opsTools) {
        expect(devTools, `dev must not have access to ${tool}`).not.toContain(tool);
      }
    });

    it('dev role with kb.read permission gets kb_search and kb_get, but remains masked', () => {
      const devWithKb = principal('dev', [...DEFAULT_ROLE_PERMISSIONS.dev, 'kb.read']);
      expect(isMasked(devWithKb)).toBe(true);
      const devTools = toolsFor(devWithKb);
      expect(devTools).toContain('kb_search');
      expect(devTools).toContain('kb_get');
      expect(devTools).not.toContain('team_load');
    });
  });

  describe('Role tool hierarchy (agent < lead <= head)', () => {
    it('agent does not receive team_load, ceo_metrics, or config_lookup', () => {
      const agent = principal('agent', DEFAULT_ROLE_PERMISSIONS.agent);
      const agentTools = toolsFor(agent);
      expect(agentTools).not.toContain('team_load');
      expect(agentTools).not.toContain('ceo_metrics');
      expect(agentTools).not.toContain('config_lookup');
    });

    it('agent granted ceo.view still cannot use ceo_metrics because ROLE_TOOLS.agent excludes it', () => {
      const agentWithCeo = principal('agent', [...DEFAULT_ROLE_PERMISSIONS.agent, 'ceo.view']);
      expect(toolsFor(agentWithCeo)).not.toContain('ceo_metrics');
    });

    it('lead without ceo.view does not get ceo_metrics, but with ceo.view gets it', () => {
      const leadWithoutCeo = principal(
        'lead',
        DEFAULT_ROLE_PERMISSIONS.lead.filter((p) => p !== 'ceo.view'),
      );
      expect(toolsFor(leadWithoutCeo)).not.toContain('ceo_metrics');

      const leadWithCeo = principal('lead', DEFAULT_ROLE_PERMISSIONS.lead);
      expect(toolsFor(leadWithCeo)).toContain('ceo_metrics');
      expect(toolsFor(leadWithCeo)).toContain('team_load');
      expect(toolsFor(leadWithCeo)).toContain('config_lookup');
    });

    it('head receives full workspace tools including team_load, ceo_metrics, and config_lookup', () => {
      const head = principal('head', DEFAULT_ROLE_PERMISSIONS.head);
      const headTools = toolsFor(head);
      expect(headTools).toContain('team_load');
      expect(headTools).toContain('ceo_metrics');
      expect(headTools).toContain('config_lookup');
      expect(headTools.length).toBeGreaterThan(
        toolsFor(principal('agent', DEFAULT_ROLE_PERMISSIONS.agent)).length,
      );
    });
  });

  describe('All assistant routes refuse client access with 403 (AC-J13)', async () => {
    const routes = (await collectRoutes()).filter((r) =>
      /^[A-Z]+ \/v1\/assistant(\/|$)/.test(r.key),
    );

    it('proves every assistant route is workspaceOnly and not public', () => {
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.isPublic, `${route.key} must NOT be public`).toBe(false);
        expect(route.workspaceOnly, `${route.key} must be workspaceOnly`).toBe(true);
      }
    });
  });
});

describe('DoD C-16: RBAC test "arg ของคนอื่น" (Cross-User & Cross-Org Isolation)', () => {
  interface RecordedCalls {
    performance: { days: number; userId: string | undefined }[];
    roster: { from: string; to: string; userId: string | undefined }[];
    ticketList: { principal: unknown; query: unknown }[];
    orgGet: { id: string; principal: unknown }[];
  }

  function createMockDeps(calls: RecordedCalls): AssistantToolDeps {
    const mockModules: Partial<ModuleReadServices> = {
      dashboard: {
        performance: (days: number, p: { userId: string }, userId?: string) => {
          calls.performance.push({ days, userId });
          return Promise.resolve({
            window: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', days },
            scope: userId ? 'all' : 'own',
            agents: [{ userId: userId ?? p.userId, name: 'Caller Agent', open: 2, resolved: 5 }],
          });
        },
        ops: () => Promise.resolve({} as never),
      },
      organizations: {
        get: (id: string, p: Principal) => {
          calls.orgGet.push({ id, principal: p });
          if (p.orgScope.kind === 'org' && p.orgScope.orgId !== id) {
            const err = new Error('Organization not found');
            (err as { status?: number }).status = 404;
            return Promise.reject(err);
          }
          return Promise.resolve({
            id,
            name: 'Org A',
            status: 'active' as const,
            tier: 'standard' as const,
            slaPolicyId: null,
            domains: [],
            lineGroupIds: [],
            healthScore: null,
            primaryContactId: null,
            contactCount: null,
            notes: '',
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          });
        },
      },
      reader: {
        viewRow: () => Promise.resolve({ t: { id: CALLER_ID, number: 1, orgId: ORG_A_ID } }),
      } as never,
    };

    return {
      database: {} as never,
      readOnly: (() => Promise.resolve({ names: [], complete: true })) as never,
      readOnlyScope: (<T>(work: () => Promise<T>) => work()) as never,
      reader: {
        list: (query: unknown, p: unknown) => {
          calls.ticketList.push({ query, principal: p });
          return Promise.resolve({ items: [], total: 0 });
        },
        viewRow: () => Promise.resolve({ t: { id: CALLER_ID, number: 1, orgId: ORG_A_ID } }),
        conversation: () => Promise.resolve([]),
      } as never,
      handoffs: {} as never,
      shiftNotes: {} as never,
      shifts: {
        status: () => Promise.resolve({ session: null } as never),
        roster: (_p: { userId: string }, query: { from: string; to: string; userId?: string }) => {
          calls.roster.push({ from: query.from, to: query.to, userId: query.userId });
          return Promise.resolve({
            timezone: 'Asia/Bangkok',
            entries: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                shiftName: 'Morning',
                onCall: false,
                userName: 'Caller Agent',
                workDate: '2026-11-08',
                startsAt: '08:00',
                endsAt: '17:00',
              },
            ],
          });
        },
        current: () => Promise.resolve({} as never),
        incomingHandoff: () => Promise.resolve({} as never),
      } as never,
      modules: mockModules as ModuleReadServices,
    } as unknown as AssistantToolDeps;
  }

  const buildHost = (deps: AssistantToolDeps, p: ReturnType<typeof principal>) =>
    buildAssistantTools(deps, {
      principal: p,
      locale: 'en',
      masked: false,
      now: new Date('2026-11-08T12:00:00Z'),
    });

  describe('performance_view: ignores userId of other agents when only performance.read.own is held', () => {
    it('agent holding performance.read.own passes userId=OTHER but tool ignores it and queries own row only', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const agent = principal('agent', ['dashboard.ops.read', 'performance.read.own'], CALLER_ID);
      const deps = createMockDeps(calls);
      const host = buildHost(deps, agent);

      const result = (await host.tools.call('performance_view', {
        days: 7,
        userId: OTHER_USER_ID, // Malicious / snooping arg!
      })) as { scope: string; agents: { userId: string }[] };

      // Tool MUST ignore the passed userId and pass undefined to the service
      expect(calls.performance).toEqual([{ days: 7, userId: undefined }]);
      expect(result.scope).toBe('own');
      expect(result.agents[0]?.userId).toBe(CALLER_ID);
    });

    it('lead holding performance.read.all passes userId=OTHER and tool honors it', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const lead = principal('lead', ['dashboard.ops.read', 'performance.read.all'], CALLER_ID);
      const deps = createMockDeps(calls);
      const host = buildHost(deps, lead);

      const result = (await host.tools.call('performance_view', {
        days: 14,
        userId: OTHER_USER_ID,
      })) as { scope: string; agents: { userId: string }[] };

      expect(calls.performance).toEqual([{ days: 14, userId: OTHER_USER_ID }]);
      expect(result.scope).toBe('all');
      expect(result.agents[0]?.userId).toBe(OTHER_USER_ID);
    });
  });

  describe('roster_view: ignores userId of other agents when lacking roster.manage', () => {
    it('agent holding shift.clock (no roster.manage) passes userId=OTHER but tool queries own schedule only', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const agent = principal('agent', ['shift.clock'], CALLER_ID);
      const deps = createMockDeps(calls);
      const host = buildHost(deps, agent);

      await host.tools.call('roster_view', {
        userId: OTHER_USER_ID, // Trying to snoop other person's schedule!
      });

      // Tool MUST ignore the passed userId and query with userId=undefined
      expect(calls.roster).toHaveLength(1);
      expect(calls.roster[0]?.userId).toBeUndefined();
    });

    it('manager holding roster.manage passes userId=OTHER and tool honors the target userId', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const manager = principal('lead', ['roster.manage'], CALLER_ID);
      const deps = createMockDeps(calls);
      const host = buildHost(deps, manager);

      await host.tools.call('roster_view', {
        userId: OTHER_USER_ID,
      });

      expect(calls.roster).toHaveLength(1);
      expect(calls.roster[0]?.userId).toBe(OTHER_USER_ID);
    });
  });

  describe('Org Scope isolation: org-scoped principal cannot read other orgs data', () => {
    it('search_tickets forwards principal orgScope to reader.list so foreign tickets are not returned', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const scopedAgent = principal('agent', ['ticket.read'], CALLER_ID, {
        kind: 'org',
        orgId: ORG_A_ID,
      });
      const deps = createMockDeps(calls);
      const host = buildHost(deps, scopedAgent);

      await host.tools.call('search_tickets', { query: 'billing' });

      expect(calls.ticketList).toHaveLength(1);
      expect((calls.ticketList[0]?.principal as { orgScope: OrgScope }).orgScope).toEqual({
        kind: 'org',
        orgId: ORG_A_ID,
      });
    });

    it('org_get rejects other org ID when principal is scoped to a different org', async () => {
      const calls: RecordedCalls = { performance: [], roster: [], ticketList: [], orgGet: [] };
      const scopedAgent = principal('agent', ['ticket.read'], CALLER_ID, {
        kind: 'org',
        orgId: ORG_A_ID,
      });
      const deps = createMockDeps(calls);
      const host = buildHost(deps, scopedAgent);

      // Caller asks for org B while scoped to org A
      await expect(host.tools.call('org_get', { id: ORG_B_ID })).rejects.toThrow(/not found/i);
      expect(calls.orgGet).toHaveLength(1);
      expect(calls.orgGet[0]?.id).toBe(ORG_B_ID);
    });
  });
});
