import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAuditedLlm, type AgentCall } from './audited.js';
import type { AiRunRecord, LlmProvider } from './contract.js';
import { AiCallDeniedError, type AiCallGuard } from './guard.js';
import { mockSettings } from './models.js';
import { MockLlmProvider } from './providers/mock.js';
import { createRedactor } from './redaction/redactor.js';
import { TEST_PROMPT } from './testing/requests.js';

// T-114a C-6: the kill switch and the budget are enforced where the model is called, not only in
// each agent, and they fail closed.

function build(guard: AiCallGuard) {
  const records: AiRunRecord[] = [];
  let providerCalls = 0;
  const inner = new MockLlmProvider({ rules: [{ promptId: 'classifier', text: 'ok' }] });
  const provider: LlmProvider = {
    kind: 'mock',
    generate: (request) => {
      providerCalls += 1;
      return inner.generate(request);
    },
  };
  const llm = createAuditedLlm({
    guard,
    settings: { load: () => Promise.resolve(mockSettings()) },
    providers: { mock: provider },
    sink: {
      record: (run) => {
        records.push(run);
        return Promise.resolve();
      },
    },
  });
  const session = createRedactor().session({ scope: 'ticket:test' });
  const call: AgentCall = {
    agent: 'classifier',
    prompt: TEST_PROMPT,
    system: session.redact('You classify.'),
    messages: [{ role: 'user', content: session.redact('hello') }],
    redaction: session,
    ticketId: null,
  };
  return { llm, call, records, calls: () => providerCalls };
}

describe('createAuditedLlm guard', () => {
  it('does not call the provider when the kill switch is on', async () => {
    const { llm, call, calls, records } = build({
      check: () => Promise.resolve({ allowed: false, reason: 'kill_switch_on' }),
    });
    await expect(llm.generate(call)).rejects.toMatchObject({
      name: 'AiCallDeniedError',
      reason: 'kill_switch_on',
    });
    expect(calls()).toBe(0);
    expect(records).toEqual([]);
  });

  it('refuses at the budget stop', async () => {
    const { llm, call, calls } = build({
      check: () => Promise.resolve({ allowed: false, reason: 'budget_stop' }),
    });
    await expect(llm.generate(call)).rejects.toBeInstanceOf(AiCallDeniedError);
    expect(calls()).toBe(0);
  });

  it('fails closed when the guard throws', async () => {
    const { llm, call, calls } = build({ check: () => Promise.reject(new Error('db down')) });
    await expect(llm.generate(call)).rejects.toMatchObject({ reason: 'policy_denied' });
    expect(calls()).toBe(0);
  });

  it('asks with the agent, the action and a reservation, and releases it after the call', async () => {
    const asked: unknown[] = [];
    let released = 0;
    const { llm, call, calls } = build({
      check: (request) => {
        asked.push(request);
        return Promise.resolve({
          allowed: true,
          release: () => {
            released += 1;
          },
        });
      },
    });
    await llm.generate({
      ...call,
      action: 'classify',
      ticketId: '00000000-0000-4000-8000-000000000001',
    });
    expect(calls()).toBe(1);
    expect(released).toBe(1);
    expect(asked).toEqual([
      {
        agent: 'classifier',
        ticketId: '00000000-0000-4000-8000-000000000001',
        action: 'classify',
        reserve: true,
      },
    ]);
  });

  it('releases the reservation when the provider fails', async () => {
    let released = 0;
    const guard: AiCallGuard = {
      check: () =>
        Promise.resolve({
          allowed: true,
          release: () => {
            released += 1;
          },
        }),
    };
    const llm = createAuditedLlm({
      guard,
      settings: { load: () => Promise.resolve(mockSettings()) },
      providers: {
        mock: { kind: 'mock', generate: () => Promise.reject(new Error('boom')) },
      },
      sink: { record: () => Promise.resolve() },
    });
    const session = createRedactor().session({ scope: 'ticket:test' });
    await expect(
      llm.generate({
        agent: 'classifier',
        prompt: TEST_PROMPT,
        system: session.redact('x'),
        messages: [],
        redaction: session,
      }),
    ).rejects.toThrow('boom');
    expect(released).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The scan: no path from an agent to a provider other than `createAuditedLlm`, and every place that
// builds one hands it a guard.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.ts$/.test(name) && !/\.(test|integration\.test)\.ts$/.test(name)) found.push(path);
  }
  return found;
}

describe('every model call goes through the guard (scan)', () => {
  it('no agent imports a provider or calls one directly', () => {
    const agents = sourceFiles(join(HERE, 'agents'));
    expect(agents.length).toBeGreaterThan(5);
    for (const file of agents) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from '\.\.\/providers\/(?!sdk\.js)/);
      expect(text, file).not.toMatch(/from '\.\.\/live\//);
      // The only `.generate(` an agent may call is the audited one.
      for (const match of text.matchAll(/(\w+(?:\.\w+)*)\.generate\(/g)) {
        expect(match[1], `${file}: ${match[0]}`).toMatch(/(^|\.)llm$/);
      }
    }
  });

  it('every createAuditedLlm in the apps gets a guard', () => {
    let seen = 0;
    for (const app of ['api', 'worker']) {
      for (const file of sourceFiles(join(REPO, 'apps', app, 'src'))) {
        const text = readFileSync(file, 'utf8');
        let at = text.indexOf('createAuditedLlm(');
        while (at !== -1) {
          seen += 1;
          expect(text.slice(at, at + 200), file).toMatch(/guard/);
          at = text.indexOf('createAuditedLlm(', at + 1);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    // Reads every source file of two apps: well past the 5 s default when the machine is busy.
  }, 60_000);
});
