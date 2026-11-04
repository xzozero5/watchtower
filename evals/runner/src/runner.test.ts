import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRedactor, DEFAULT_PROMPTS_DIR, loadPromptCatalog } from '@watchtower/ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EvalCase, LoadedCase } from './case.js';
import { runEval } from './eval.js';
import { EvalLoadError, loadCases } from './load.js';
import { scrub } from './replay.js';
import { buildReport, compareReports, formatReport, parseBaseline, summarize } from './report.js';
import { caseTicketId, createRig, EvalSetupError } from './rig.js';

const SMOKE = fileURLToPath(new URL('../cases', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wt-eval-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const classifierCase = (
  over: Partial<Extract<EvalCase, { agent: 'classifier' }>> = {},
): EvalCase => ({
  id: 'unit-classifier',
  agent: 'classifier',
  mockAnswer: { type: 'new_customer_issue', intentKey: 'a', confidence: 0.9, reason: 'r' },
  input: {
    channel: 'email',
    subject: 's',
    body: 'b',
    intents: [{ key: 'a', name: 'A' }],
  },
  expect: { intentKey: 'a' },
  ...over,
});
const loaded = (item: EvalCase): LoadedCase => ({ case: item, source: 'golden', file: 'x.json' });

describe('loadCases', () => {
  it('reads a case, an array and a {cases} wrapper, and tags the source', () => {
    writeFileSync(join(dir, 'one.json'), JSON.stringify(classifierCase({ id: 'one-case' })));
    writeFileSync(
      join(dir, 'many.json'),
      JSON.stringify({
        cases: [classifierCase({ id: 'two-case' }), classifierCase({ id: 'three-case' })],
      }),
    );
    const found = loadCases([{ dir, source: 'golden' }], dir);
    expect(found.map((item) => item.case.id).toSorted()).toEqual([
      'one-case',
      'three-case',
      'two-case',
    ]);
    expect(found.every((item) => item.source === 'golden')).toBe(true);
  });

  it('is empty for a directory that does not exist, and says which file is broken', () => {
    expect(loadCases([{ dir: join(dir, 'nope'), source: 'replay' }], dir)).toEqual([]);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad-case', agent: 'classifier' }));
    expect(() => loadCases([{ dir, source: 'golden' }], dir)).toThrow(/bad\.json/);
    writeFileSync(join(dir, 'bad.json'), '{ nope');
    expect(() => loadCases([{ dir, source: 'golden' }], dir)).toThrow(EvalLoadError);
  });

  it('refuses an id used twice, so a case cannot hide behind another', () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(classifierCase()));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(classifierCase()));
    expect(() => loadCases([{ dir, source: 'golden' }], dir)).toThrow(/also in/);
  });

  it('loads the runner smoke cases and the golden folder as they are in the repo', () => {
    const smoke = loadCases([{ dir: SMOKE, source: 'smoke' }]);
    expect(smoke.map((item) => item.case.agent).toSorted()).toEqual([
      'classifier',
      'classifier',
      'drafter',
      'drafter',
      'grader',
      'grader',
      'kb_author',
      'kb_author',
    ]);
  });
});

describe('runEval on the mock provider', () => {
  it('passes the smoke cases, records one ai_run per call and never reaches for a socket', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 50, env: {} });
    const results = await runEval({ cases: loadCases([{ dir: SMOKE, source: 'smoke' }]), rig });
    expect(results).toHaveLength(8);
    expect(results.filter((result) => !result.pass).map((result) => result.id)).toEqual([]);
    expect(results.every((result) => result.calls === 1)).toBe(true);
    expect(rig.guard.calls()).toBe(8);
    const report = buildReport('mock', results);
    expect(report.summary.map((row) => [row.agent, row.promptVersion, row.passRate])).toEqual([
      ['classifier', 1, 1],
      ['drafter', 2, 1],
      ['grader', 1, 1],
      ['kb_author', 1, 1],
    ]);
  });

  it('fails a case whose answer breaks its expectation, and says which check', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 5, env: {} });
    const wrong = classifierCase({ expect: { intentKey: 'b', minConfidence: 0.99 } });
    const [result] = await runEval({ cases: [loaded(wrong)], rig });
    expect(result?.pass).toBe(false);
    expect(result?.checks.filter((check) => !check.pass).map((check) => check.name)).toEqual([
      'intent',
      'confidence',
    ]);
  });

  it('counts an unusable answer as a failure with its reason, not as a pass', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 5, env: {} });
    const [result] = await runEval({
      cases: [loaded(classifierCase({ mockAnswer: 'not json at all' }))],
      rig,
    });
    expect(result).toMatchObject({ pass: false, status: 'failed', reason: 'model_output_invalid' });
  });

  it('stops at the call budget: the next case is not answered and fails', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 1, env: {} });
    const results = await runEval({
      cases: [
        loaded(classifierCase({ id: 'first-case' })),
        loaded(classifierCase({ id: 'second-case' })),
      ],
      rig,
    });
    expect(results.map((result) => [result.id, result.pass, result.status])).toEqual([
      ['first-case', true, 'ok'],
      ['second-case', false, 'skipped'],
    ]);
    expect(rig.guard.calls()).toBe(1);
  });

  it('keeps ticket data out of the prompt (N4): the address in a case never reaches the provider', async () => {
    const rig = createRig({ provider: 'mock', maxCalls: 5, env: {} });
    const seen: string[] = [];
    const deps = rig.depsFor(classifierCase(), {});
    const original = deps.llm.generate.bind(deps.llm);
    deps.llm.generate = (call) => {
      seen.push(call.messages.map((message) => String(message.content)).join(''));
      return original(call);
    };
    const { classifyTicket } = await import('@watchtower/ai');
    await classifyTicket(deps, {
      ticketId: caseTicketId('x-case'),
      scope: 'eval:x-case',
      channel: 'email',
      subject: 's',
      body: 'write to jane@customer.example',
      intents: [{ key: 'a', name: 'A' }],
    });
    expect(seen.join('')).not.toContain('jane@customer.example');
  });
});

describe('prompt versions', () => {
  function twoVersions(): string {
    const prompts = join(dir, 'prompts');
    mkdirSync(prompts);
    for (const name of ['classifier.v1.md', 'summarizer.v1.md']) {
      copyFileSync(join(DEFAULT_PROMPTS_DIR, name), join(prompts, name));
    }
    const v1 = readFileSync(join(DEFAULT_PROMPTS_DIR, 'classifier.v1.md'), 'utf8');
    writeFileSync(join(prompts, 'classifier.v2.md'), v1.replace('version: 1', 'version: 2'));
    return prompts;
  }

  it('reports a pass rate per prompt version with --all-versions, each with its own hash', async () => {
    const rig = createRig({
      provider: 'mock',
      maxCalls: 10,
      env: {},
      prompts: loadPromptCatalog(twoVersions()),
    });
    const results = await runEval({ cases: [loaded(classifierCase())], rig, allVersions: true });
    const rows = summarize(results);
    expect(rows.map((row) => [row.promptVersion, row.passed, row.total])).toEqual([
      [1, 1, 1],
      [2, 1, 1],
    ]);
    expect(new Set(rows.map((row) => row.promptHash)).size).toBe(2);
  });

  it('pins one version, and a version that does not exist stops the run', async () => {
    const rig = createRig({
      provider: 'mock',
      maxCalls: 10,
      env: {},
      prompts: loadPromptCatalog(twoVersions()),
    });
    const [pinned] = await runEval({
      cases: [loaded(classifierCase())],
      rig,
      pins: { classifier: 1 },
    });
    expect(pinned?.promptVersion).toBe(1);
    const [latest] = await runEval({ cases: [loaded(classifierCase())], rig });
    expect(latest?.promptVersion).toBe(2);
    await expect(
      runEval({ cases: [loaded(classifierCase())], rig, pins: { classifier: 9 } }),
    ).rejects.toThrow(/classifier/);
  });
});

describe('compareReports', () => {
  const item = (id: string, pass: boolean, promptVersion = 1) => ({
    id,
    agent: 'classifier' as const,
    source: 'golden' as const,
    intent: null,
    promptId: 'classifier',
    promptVersion,
    promptHash: 'h',
    pass,
    status: 'ok' as const,
    reason: null,
    checks: [],
    calls: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: null,
    latencyMs: 1,
  });

  it('names a case that passed before and fails now, and a pass rate that fell', () => {
    const before = buildReport('mock', [
      item('a-case', true),
      item('b-case', false),
      item('c-case', true),
    ]);
    const now = buildReport('mock', [
      item('a-case', false),
      item('b-case', true),
      item('c-case', true),
    ]);
    const comparison = compareReports(now, parseBaseline(JSON.parse(JSON.stringify(before))));
    expect(comparison.regressions).toEqual([
      expect.objectContaining({ agent: 'classifier', cases: ['a-case'] }),
    ]);
    expect(comparison.fixed).toEqual(['classifier@1:b-case']);
    expect(formatReport(now, comparison)).toContain('REGRESSION classifier@v1');
  });

  it('does not judge a prompt version the baseline never saw', () => {
    const before = buildReport('mock', [item('a-case', true, 1)]);
    const now = buildReport('mock', [item('a-case', false, 2)]);
    const comparison = compareReports(now, parseBaseline(JSON.parse(JSON.stringify(before))));
    expect(comparison.regressions).toEqual([]);
    expect(comparison.notInBaseline).toEqual(['classifier@2']);
  });
});

describe('a real provider', () => {
  it('stops with a plain list of what is missing, and never prints a value [ASK-HUMAN]', () => {
    try {
      createRig({
        provider: 'claude-cli',
        maxCalls: 5,
        env: { CLAUDE_CLI_BRIDGE_TOKEN: '' },
        fetch: () => Promise.reject(new Error('must not be called')),
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EvalSetupError);
      const message = (error as Error).message;
      expect(message).toContain('CLAUDE_CLI_BRIDGE_TOKEN is not set');
      expect(message).toContain('AI_MODEL_DEEP is not set');
    }
  });

  it('calls only the bridge it was given, through the budget guard, with the tier model from the environment', async () => {
    const calls: string[] = [];
    const rig = createRig({
      provider: 'claude-cli',
      maxCalls: 1,
      env: {
        CLAUDE_CLI_BRIDGE_TOKEN: 'not-a-real-token',
        AI_MODEL_DEEP: 'tier-deep',
        AI_MODEL_STANDARD: 'tier-standard',
        AI_MODEL_LIGHT: 'tier-light',
        AI_MODEL_PRICES: JSON.stringify({
          'tier-deep': { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
          'tier-standard': { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
          'tier-light': { inputUsdPerMTok: 1, outputUsdPerMTok: 2 },
        }),
      },
      fetch: (input, init) => {
        calls.push(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          model?: string;
        };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              text: JSON.stringify({
                type: 'new_customer_issue',
                intentKey: 'a',
                confidence: 0.9,
                reason: 'r',
              }),
              model: body.model ?? 'tier-light',
              usage: { inputTokens: 1000, outputTokens: 100 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const results = await runEval({
      cases: [
        loaded(classifierCase({ id: 'live-one' })),
        loaded(classifierCase({ id: 'live-two' })),
      ],
      rig,
    });
    expect(calls).toEqual(['http://127.0.0.1:4317/v1/generate']);
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['live-one', 'ok'],
      ['live-two', 'skipped'],
    ]);
    expect(results[0]?.costUsd).toBeCloseTo(0.0012);
  });
});

describe('scrub (replay export)', () => {
  it('leaves no address, phone or known name, and no placeholder an agent would escape', () => {
    const session = createRedactor({ names: () => ['Somchai Jaidee'] }).session({ scope: 't' });
    const text = scrub(
      session,
      'Hi, I am Somchai Jaidee, mail somchai@customer.example or call 081-234-5678.',
    );
    expect(text).not.toMatch(/somchai|081-234|customer\.example/i);
    expect(text).not.toMatch(/\[[A-Z_]+_\d+\]/);
    expect(text).toContain('(email)');
  });
});
