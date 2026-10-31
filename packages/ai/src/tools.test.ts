import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ToolAllowRule, ToolDefinition } from './contract.js';
import {
  createToolRegistry,
  defineTool,
  ToolBudgetError,
  ToolInputError,
  ToolNotAllowedError,
  ToolOutputError,
  ToolRegistryError,
} from './tools.js';

const lookup = defineTool({
  name: 'kb_search',
  description: 'Search the knowledge base',
  readOnly: true,
  input: z.object({ query: z.string().min(1) }),
  output: z.object({ hits: z.array(z.object({ id: z.string(), title: z.string() })) }),
  execute: (input) => Promise.resolve({ hits: [{ id: 'a1', title: `about ${input.query}` }] }),
});

const logs = defineTool({
  name: 'gcp_logs',
  description: 'Read logs',
  readOnly: true,
  input: z.object({ filter: z.string() }),
  output: z.object({ lines: z.array(z.string()) }),
  execute: () => Promise.resolve({ lines: ['line'] }),
});

const rules: ToolAllowRule[] = [
  { agent: '*', intent: '*', tools: ['kb_search'] },
  { agent: 'investigator', intent: 'service_outage', stages: [0, 1, 2], tools: ['gcp_logs'] },
];

function registry(extraRules: readonly ToolAllowRule[] = rules) {
  const created = createToolRegistry(extraRules);
  created.register(lookup);
  created.register(logs);
  return created;
}

describe('tool registry: registration (N2)', () => {
  it('rejects a tool that is not read-only, even if the types are bypassed', () => {
    const writer = { ...lookup, name: 'send_reply', readOnly: false } as unknown as ToolDefinition;
    expect(() => {
      createToolRegistry([]).register(writer);
    }).toThrow(ToolRegistryError);
  });

  it('cannot declare a writing tool at compile time', () => {
    defineTool({
      name: 'send_reply',
      description: 'writes',
      // @ts-expect-error readOnly must be the literal true
      readOnly: false,
      input: z.object({}),
      output: z.object({}),
      execute: () => Promise.resolve({}),
    });
  });

  it('rejects duplicate and malformed names', () => {
    const created = registry();
    expect(() => {
      created.register(lookup);
    }).toThrow(ToolRegistryError);
    expect(() => {
      created.register({ ...lookup, name: 'Bad Name' });
    }).toThrow(ToolRegistryError);
  });
});

describe('tool registry: allow-list per agent, intent and stage', () => {
  it('lists only the tools granted to the scope', () => {
    const created = registry();
    const names = (agent: 'investigator' | 'classifier', intent: string | null, stage: 0 | 3) =>
      created
        .scope({ agent, intent, stage })
        .list()
        .map((tool) => tool.name);

    expect(names('investigator', 'service_outage', 0)).toEqual(['gcp_logs', 'kb_search']);
    expect(names('investigator', 'billing', 0)).toEqual(['kb_search']);
    expect(names('classifier', 'service_outage', 0)).toEqual(['kb_search']);
    expect(names('investigator', 'service_outage', 3)).toEqual(['kb_search']);
    expect(names('investigator', null, 0)).toEqual(['kb_search']);
  });

  it('denies by default: no rules, no tools', async () => {
    const created = registry([]);
    const scoped = created.scope({ agent: 'investigator', intent: 'x', stage: 0 });
    expect(scoped.list()).toEqual([]);
    await expect(scoped.call('kb_search', { query: 'q' })).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
  });

  it('refuses a registered tool outside the scope and records the refusal', async () => {
    const scoped = registry().scope({ agent: 'classifier', intent: 'service_outage', stage: 0 });
    await expect(scoped.call('gcp_logs', { filter: 'x' })).rejects.toBeInstanceOf(
      ToolNotAllowedError,
    );
    await expect(scoped.call('does_not_exist', {})).rejects.toBeInstanceOf(ToolNotAllowedError);
    expect(scoped.calls().map((call) => [call.name, call.ok, call.errorCode])).toEqual([
      ['gcp_logs', false, 'ToolNotAllowedError'],
      ['does_not_exist', false, 'ToolNotAllowedError'],
    ]);
  });

  it('ignores a rule that names a tool nobody registered', () => {
    const created = createToolRegistry([{ agent: '*', intent: '*', tools: ['ghost'] }]);
    expect(created.scope({ agent: 'drafter', intent: null, stage: 0 }).list()).toEqual([]);
  });
});

describe('tool registry: validation and audit', () => {
  const scope = { agent: 'investigator', intent: 'service_outage', stage: 0 } as const;

  it('validates input and returns validated output, recording the call', async () => {
    const scoped = registry().scope(scope);
    const output = await scoped.call('kb_search', { query: 'password' });
    expect(output).toEqual({ hits: [{ id: 'a1', title: 'about password' }] });
    const [record] = scoped.calls();
    expect(record).toMatchObject({ name: 'kb_search', ok: true, errorCode: null });
    expect(record?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toContain('password');
  });

  it('rejects bad input before running the tool', async () => {
    let ran = false;
    const created = createToolRegistry([{ agent: '*', intent: '*', tools: ['kb_search'] }]);
    created.register({
      ...lookup,
      execute: () => {
        ran = true;
        return Promise.resolve({ hits: [] });
      },
    });
    const scoped = created.scope(scope);
    await expect(scoped.call('kb_search', { query: '' })).rejects.toBeInstanceOf(ToolInputError);
    await expect(scoped.call('kb_search', 'nope')).rejects.toBeInstanceOf(ToolInputError);
    expect(ran).toBe(false);
  });

  it('rejects output that breaks the schema', async () => {
    const created = createToolRegistry([{ agent: '*', intent: '*', tools: ['kb_search'] }]);
    created.register({
      ...lookup,
      execute: () => Promise.resolve({ hits: 'not an array' }),
    });
    await expect(created.scope(scope).call('kb_search', { query: 'q' })).rejects.toBeInstanceOf(
      ToolOutputError,
    );
  });

  it('records a tool that throws and rethrows', async () => {
    const created = createToolRegistry([{ agent: '*', intent: '*', tools: ['kb_search'] }]);
    created.register({
      ...lookup,
      execute: () => Promise.reject(new RangeError('boom')),
    });
    const scoped = created.scope(scope);
    await expect(scoped.call('kb_search', { query: 'q' })).rejects.toBeInstanceOf(RangeError);
    expect(scoped.calls()[0]).toMatchObject({ ok: false, errorCode: 'RangeError' });
  });

  it('enforces a per-run call budget', async () => {
    const scoped = registry().scope(scope, { maxCalls: 2 });
    await scoped.call('kb_search', { query: 'a' });
    await scoped.call('kb_search', { query: 'b' });
    await expect(scoped.call('kb_search', { query: 'c' })).rejects.toBeInstanceOf(ToolBudgetError);
    expect(scoped.calls()).toHaveLength(3);
  });

  it('passes the scope and abort signal to the tool', async () => {
    const controller = new AbortController();
    let seen: unknown;
    const created = createToolRegistry([{ agent: '*', intent: '*', tools: ['kb_search'] }]);
    created.register({
      ...lookup,
      execute: (_input: unknown, context: unknown) => {
        seen = context;
        return Promise.resolve({ hits: [] });
      },
    });
    await created
      .scope(scope, { abortSignal: controller.signal })
      .call('kb_search', { query: 'q' });
    expect(seen).toMatchObject({ ...scope, abortSignal: controller.signal });
  });
});
