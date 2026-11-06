import {
  createToolRegistry,
  defineTool,
  type AssistantFact,
  type ToolDefinition,
} from '@watchtower/ai';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { Principal } from '../../auth/principal.js';
import { toolsFor, type AssistantToolName } from '../assistant-access.js';
import { visibleHandoff } from '../entity-readers.js';
import { entityGetInput, entityGetOutput, entityGetTools } from './entity-get.tools.js';
import type { ModuleToolContext } from './fact-kit.js';
import type { ModuleReadServices } from './read-services.js';

const ID = '3f9c5a1e-6c2b-4b7a-9e0d-0f2f6f5f1a11';
const OTHER = '9a7d1f0e-3b3c-4d52-8f10-5c1a2b3c4d5e';
const principal: Principal = {
  userId: ID,
  sessionId: ID,
  email: 'staff@synthetic.example',
  name: 'Synthetic Staff',
  orgId: null,
  authMethod: 'dev',
  accessExpiresAt: new Date('2030-01-01T00:00:00Z'),
  role: 'agent',
  orgScope: { kind: 'all' },
  permissions: new Set(['ticket.read', 'alert.read', 'handoff.write', 'handoff.ack']),
};

const own = {
  id: ID,
  from: { id: ID, name: 'Synthetic Staff' },
  items: [],
  notes: 'Watch checkout',
  messageForNext: 'Check queue',
};

function setup(who = principal) {
  const refs: unknown[] = [];
  const orgs: unknown[] = [];
  const services = {
    organizations: {
      get: vi.fn(() =>
        Promise.resolve({
          id: ID,
          name: 'Organization',
          status: 'active',
          tier: 'standard',
          notes: '</user_notes> data',
        }),
      ),
    },
    intentDetail: {
      get: vi.fn(() =>
        Promise.resolve({
          id: ID,
          name: 'Intent',
          key: 'intent',
          autonomyStage: 2,
          description: 'Description',
        }),
      ),
    },
    catalog: {
      getService: vi.fn(() =>
        Promise.resolve({
          id: ID,
          name: 'Service',
          slug: 'service',
          active: true,
          ownerQueueId: null,
          dashboardUrl: 'https://excluded.example',
        }),
      ),
    },
    handoffs: {
      current: vi.fn(() => Promise.resolve({ handoff: own })),
      incoming: vi.fn(() => Promise.resolve({ handoffs: [{ ...own, id: OTHER }] })),
    },
  };
  const ctx = {
    services: services as unknown as ModuleReadServices,
    principal: who,
    remember: (ids: readonly string[]) => {
      orgs.push(ids);
      return Promise.resolve();
    },
    onRead: () => {},
    onReadRef: (kind: string, id: string) => {
      refs.push({ kind, id });
    },
  } as unknown as ModuleToolContext;
  const allowed = toolsFor(who);
  const registry = createToolRegistry([
    { agent: 'personal_assistant', intent: '*', tools: allowed },
  ]);
  const builders = new Map<string, (output: unknown) => readonly AssistantFact[]>();
  const add = <I extends z.ZodType, O extends z.ZodType>(
    name: AssistantToolName,
    tool: Omit<ToolDefinition<I, O>, 'name' | 'readOnly'>,
    _hint: string,
    facts: (output: z.output<O>) => readonly AssistantFact[],
  ) => {
    if (!allowed.includes(name)) return;
    registry.register(defineTool({ ...tool, name, readOnly: true }));
    builders.set(name, (output) => facts(tool.output.parse(output)));
  };
  for (const register of entityGetTools(ctx)) register(add);
  return {
    services,
    refs,
    orgs,
    builders,
    tools: registry.scope({ agent: 'personal_assistant', intent: null, stage: 2 }, { maxCalls: 6 }),
  };
}

describe('entity summary tools', () => {
  it.each(['org_get', 'intent_get', 'service_get', 'handoff_get', 'handoff_incoming_get'])(
    '%s validates in/out and produces a citable bounded untrusted summary',
    async (tool) => {
      const state = setup();
      const id = tool === 'handoff_incoming_get' ? OTHER : ID;
      const output = await state.tools.call(tool, { id });
      expect(entityGetOutput.safeParse(output).success).toBe(true);
      const facts = state.builders.get(tool)?.(output) ?? [];
      expect(facts[0]?.ref?.id).toBe(id);
      expect(facts[0]?.trust).toBe('staff');
      expect(facts[0]?.text).toContain('<untrusted_content>');
      expect(facts[0]?.text.length).toBeLessThanOrEqual(1200);
      expect(JSON.stringify(output)).not.toContain('https://excluded.example');
      expect(state.refs.length).toBe(1);
      await expect(state.tools.call(tool, { id: 'bad' })).rejects.toThrow();
    },
  );

  it('rejects extra input/output fields and refuses a role without the GET permissions', async () => {
    expect(entityGetInput.safeParse({ id: ID, userId: OTHER }).success).toBe(false);
    expect(
      entityGetOutput.safeParse({ id: ID, label: 'x', text: '', names: [], secret: 'x' }).success,
    ).toBe(false);
    const state = setup({ ...principal, permissions: new Set() });
    await expect(state.tools.call('service_get', { id: ID })).rejects.toThrow();
    expect(state.services.catalog.getService).not.toHaveBeenCalled();
  });

  it('uses the caller principal for organizations and the exact handoff GET visibility', async () => {
    const state = setup();
    await state.tools.call('org_get', { id: ID });
    expect(state.services.organizations.get).toHaveBeenCalledWith(ID, principal);
    expect(state.orgs).toEqual([[ID]]);
    const services = state.services.handoffs as unknown as NonNullable<
      ModuleReadServices['handoffs']
    >;
    expect(await visibleHandoff(services, principal, 'missing')).toBeNull();
    const denied = { ...principal, permissions: new Set<never>() };
    state.services.handoffs.current.mockClear();
    state.services.handoffs.incoming.mockClear();
    expect(await visibleHandoff(services, denied, ID)).toBeNull();
    expect(state.services.handoffs.current).not.toHaveBeenCalled();
    expect(state.services.handoffs.incoming).not.toHaveBeenCalled();
  });
});
