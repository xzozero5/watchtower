import { createHash, randomBytes } from 'node:crypto';

import {
  buildAiSettings,
  createAuditedLlm,
  createCliBridgeProvider,
  createRedactor,
  DevMockLlmProvider,
  loadPromptCatalog,
  CONFIGURABLE_AGENTS,
  MockLlmProvider,
  agentModelVariable,
  type AgentDeps,
  type AiCallGuard,
  type AiRunRecord,
  type FetchLike,
  type LlmProvider,
  type PromptCatalog,
  type SettingsSource,
} from '@watchtower/ai';

import type { EvalCase } from './case.js';

export class EvalSetupError extends Error {
  override readonly name = 'EvalSetupError';
}

export type EvalProviderKind = 'mock' | 'claude-cli';

/**
 * The budget guard of an eval run (N2/N3, `[ASK-HUMAN]` on cost): every model call asks it, and it
 * stops the run after `maxCalls` calls. The cap is per run, not per day: an eval is started by a person.
 */
export function createEvalGuard(maxCalls: number): AiCallGuard & { readonly calls: () => number } {
  let used = 0;
  return {
    calls: () => used,
    check(request) {
      // The early check of an agent does not reserve; the model call itself (`reserve`) is what is counted.
      if (request.reserve !== true) {
        return Promise.resolve(
          used >= maxCalls ? { allowed: false, reason: 'budget_stop' } : { allowed: true },
        );
      }
      if (used >= maxCalls) return Promise.resolve({ allowed: false, reason: 'budget_stop' });
      used += 1;
      return Promise.resolve({ allowed: true });
    },
  };
}

/** The pin: `grader` at version 2 makes every `latest('grader')` of an agent answer version 2. */
export function pinCatalog(
  base: PromptCatalog,
  pins: Readonly<Record<string, number>>,
): PromptCatalog {
  return {
    ...base,
    latest(id) {
      const version = pins[id];
      return version === undefined ? base.latest(id) : base.version(id, version);
    },
  };
}

/** A UUID derived from the case id, so the audit record of a case has a stable, valid ticket id. */
export function caseTicketId(id: string): string {
  const hex = createHash('sha256').update(`eval:${id}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface RigOptions {
  readonly provider: EvalProviderKind;
  readonly maxCalls: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchLike;
  readonly prompts?: PromptCatalog;
}

export interface Rig {
  readonly provider: EvalProviderKind;
  readonly guard: ReturnType<typeof createEvalGuard>;
  readonly prompts: PromptCatalog;
  /** Select the case the provider answers for (the mock uses its `mockAnswer`). */
  select(item: EvalCase): void;
  /** `AgentDeps` for one case, with the prompt versions pinned. */
  depsFor(item: EvalCase, pins: Readonly<Record<string, number>>): AgentDeps;
  /** The same, for a run that has no `EvalCase` (the procedure simulation, T-303d): only the names the redactor must know. */
  depsForNames(names: readonly string[], pins: Readonly<Record<string, number>>): AgentDeps;
  /** The `ai_run` records written since the last call. */
  drainRuns(): AiRunRecord[];
}

/**
 * Builds the agents' dependencies for an eval run: the same `createAuditedLlm` the apps use (redaction
 * report, `ai_run` record, guard), with the records kept in memory. `mock` never opens a socket.
 * `claude-cli` needs the bridge token and the model of each tier in the environment; without them it
 * stops with a plain-language list of what is missing (never a value).
 */
export function createRig(options: RigOptions): Rig {
  const runs: AiRunRecord[] = [];
  const guard = createEvalGuard(options.maxCalls);
  const prompts = options.prompts ?? loadPromptCatalog();
  let current: EvalCase | undefined;

  let provider: LlmProvider;
  let settings: SettingsSource;
  if (options.provider === 'mock') {
    const dev = new DevMockLlmProvider();
    provider = {
      kind: 'mock',
      generate(request) {
        const answer = current?.mockAnswer;
        if (answer === undefined) return dev.generate(request);
        const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
        return new MockLlmProvider({ rules: [{ promptId: request.prompt.id, text }] }).generate(
          request,
        );
      },
    };
    // The mock settings come from the package: fixed models named `mock-*`, no real hash key.
    const built = buildAiSettings({
      AI_PROVIDER: 'mock',
      APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    });
    settings = { load: () => Promise.resolve(built.settings) };
  } else {
    const token = options.env.CLAUDE_CLI_BRIDGE_TOKEN ?? '';
    const bridgeUrl = options.env.CLAUDE_CLI_BRIDGE_URL ?? 'http://127.0.0.1:4317';
    const built = buildAiSettings({
      AI_PROVIDER: 'claude-cli',
      AI_MODEL_DEEP: options.env.AI_MODEL_DEEP,
      AI_MODEL_STANDARD: options.env.AI_MODEL_STANDARD,
      AI_MODEL_LIGHT: options.env.AI_MODEL_LIGHT,
      AI_MODEL_PRICES: options.env.AI_MODEL_PRICES,
      ...Object.fromEntries(
        CONFIGURABLE_AGENTS.map((agent) => [
          agentModelVariable(agent),
          options.env[agentModelVariable(agent)],
        ]),
      ),
      APP_ENCRYPTION_KEY: options.env.APP_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
    });
    const missing = [...built.problems];
    if (token.trim() === '') missing.push('CLAUDE_CLI_BRIDGE_TOKEN is not set');
    const fetchImpl = options.fetch;
    if (fetchImpl === undefined) missing.push('no fetch was given to the runner');
    if (missing.length > 0 || fetchImpl === undefined) {
      throw new EvalSetupError(
        `cannot run with claude-cli [ASK-HUMAN]:\n  - ${missing.join('\n  - ')}`,
      );
    }
    provider = createCliBridgeProvider({ bridgeUrl, token, fetch: fetchImpl });
    settings = { load: () => Promise.resolve(built.settings) };
  }

  const llm = createAuditedLlm({
    guard,
    settings,
    providers: { [options.provider]: provider },
    sink: {
      record(run) {
        runs.push(run);
        return Promise.resolve();
      },
    },
  });
  const depsForNames = (names: readonly string[], pins: Readonly<Record<string, number>>) => ({
    llm,
    redactor: createRedactor({ names: () => names }),
    prompts: pinCatalog(prompts, pins),
    guard,
  });
  return {
    provider: options.provider,
    guard,
    prompts,
    select(item) {
      current = item;
    },
    depsFor(item, pins) {
      return depsForNames(item.names ?? [], pins);
    },
    depsForNames,
    drainRuns() {
      return runs.splice(0, runs.length);
    },
  };
}
