import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  createLocalEmbeddingProvider,
  createLocalNameFinder,
  createRedactor,
  MockEmbeddingProvider,
  type EmbeddingProvider,
} from '@watchtower/ai';
import { createDatabase } from '@watchtower/db';

import { EVAL_AGENTS, EVAL_SOURCES, type EvalAgent, type EvalSource } from './case.js';
import { runEval } from './eval.js';
import { loadCases, type CaseDir } from './load.js';
import {
  evaluateRedaction,
  formatRedactionReport,
  redactionCorpusSchema,
  redactionGate,
  type RedactFn,
} from './redaction-eval.js';
import { formatSimilarityReport, kbQuerySetSchema } from './kb-similarity.js';
import { runKbSimilarity } from './kb-similarity-run.js';
import { formatRecord, recordReplay } from './record.js';
import { exportReplay } from './replay.js';
import { buildReport, compareReports, formatReport, parseBaseline } from './report.js';
import { createRig, EvalSetupError, type EvalProviderKind } from './rig.js';
import {
  formatSimulation,
  parseStepsFile,
  simulateFixture,
  simulationFixtureSchema,
} from './simulate.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EVALS = join(ROOT, 'evals');

/** Where each source lives. `golden` is written by people and never by this program (N7). */
const SOURCE_DIRS: Readonly<Record<EvalSource, string>> = {
  golden: join(EVALS, 'golden'),
  replay: join(EVALS, '.replay'),
  smoke: join(EVALS, 'runner', 'cases'),
  proposal: join(EVALS, 'proposals'),
};

const USAGE = `Watchtower eval runner (T-302)

  pnpm eval                      run the cases of evals/golden, evals/.replay and the runner's own smoke cases
  pnpm eval -- [options]

Options
  --provider mock|claude-cli     default mock (offline). claude-cli needs the bridge token and the model of each tier in the environment
  --source golden,replay,smoke,proposal   which cases (default golden,replay,smoke; smoke is skipped for a real provider)
  --agent classifier,drafter,grader,kb_author,insight_narrator,personal_assistant
  --prompt grader=2              pin a prompt version (repeatable); the rest run at their latest
  --all-versions                 run every case at every version of its prompt
  --baseline path.json           compare with an earlier report; a case that passed and now fails is a regression
  --out path.json                where to write the report (default evals/reports/latest.json; --no-write to skip)
  --min-pass-rate 1              exit 1 when any prompt version passes less often (default 1)
  --max-calls 100                stop after this many model calls (the budget guard of the run)

  pnpm --filter @watchtower/eval-runner redaction [--ner off|local] [--json] [--min-recall 1] [--max-false-positive 0.02]
    deterministic recall / false-positive eval of the redactor on evals/runner/redaction/corpus.json (no model, no network, T-302e)

  pnpm --filter @watchtower/eval-runner simulate -- --steps steps.json [--baseline other.json] [--cases cases.json] [--provider mock]
    runs the steps of a procedure version on made-up cases and tools (default evals/runner/simulation/smoke.json): the same
    engine the worker runs on resolved tickets before a publish (T-303d, ADR-026 section 6). Exit 1 unless it passes.

  pnpm --filter @watchtower/eval-runner record -- --intent <key> --as <email> [--dry-run] [--max-calls 100] [--days 90] [--limit 30]
    runs the replay of the combination the gate reads (drafter/grader model, prompt versions, published procedure) on the
    latest resolved, non-seed tickets of the intent plus the redaction eval, then calls record_replay_result() as that
    person (needs ai.autonomy.promote; the database checks). Provider from AI_PROVIDER (mock by default: stored, never passed).
    Prints numbers only, no ticket text. (T-306g)

  pnpm --filter @watchtower/eval-runner kb-similarity -- [--url http://127.0.0.1:11434] [--model bge-m3] [--kb-dir examples/kb] [--fake]
    tunes KB_MIN_VECTOR_SIMILARITY (T-431, ADR-030): embeds examples/kb and a Thai/English query set
    (evals/runner/kb-similarity/queries.json) with the local embedder and prints recall and noise per floor.
    --fake uses made-up vectors (no embedder; only checks the plumbing, the numbers mean nothing). The host must
    be loopback or a compose service name. Changes nothing; see docs/runbooks/local-poc.md.

  pnpm --filter @watchtower/eval-runner replay -- --days 30 --limit 50
    reads resolved tickets from DATABASE_URL, redacts them and writes evals/.replay/replay.json (git-ignored)
`;

function list<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  what: string,
): T[] {
  if (value === undefined || value === '') return [];
  return value.split(',').map((item) => {
    const found = allowed.find((candidate) => candidate === item.trim());
    if (found === undefined) throw new EvalSetupError(`unknown ${what}: ${item}`);
    return found;
  });
}

async function run(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string', default: process.env.EVAL_PROVIDER ?? 'mock' },
      source: { type: 'string' },
      agent: { type: 'string' },
      prompt: { type: 'string', multiple: true },
      'all-versions': { type: 'boolean', default: false },
      baseline: { type: 'string' },
      out: { type: 'string', default: join(EVALS, 'reports', 'latest.json') },
      'no-write': { type: 'boolean', default: false },
      'min-pass-rate': { type: 'string', default: '1' },
      'max-calls': { type: 'string', default: '100' },
      json: { type: 'boolean', default: false },
    },
  });
  const provider = values.provider;
  if (provider !== 'mock' && provider !== 'claude-cli') {
    throw new EvalSetupError(`unknown provider: ${provider} (mock or claude-cli)`);
  }
  const kind: EvalProviderKind = provider;
  const sources = list(values.source, EVAL_SOURCES, 'source');
  const wantedSources: EvalSource[] =
    sources.length > 0
      ? sources
      : kind === 'mock'
        ? ['golden', 'replay', 'smoke']
        : ['golden', 'replay'];
  // The smoke cases pin the answer of the mock provider; a real model has no such answer to check.
  const usable = kind === 'mock' ? wantedSources : wantedSources.filter((s) => s !== 'smoke');
  const dirs: CaseDir[] = usable.map((source) => ({ dir: SOURCE_DIRS[source], source }));
  const cases = loadCases(dirs, ROOT);

  const pins: Record<string, number> = {};
  for (const pin of values.prompt ?? []) {
    const [id, version] = pin.split('=');
    const number = Number(version);
    if (id === undefined || id === '' || !Number.isInteger(number) || number < 1) {
      throw new EvalSetupError(`--prompt wants id=version, got "${pin}"`);
    }
    pins[id] = number;
  }

  if (cases.length === 0) {
    console.log(
      `eval: no cases under ${usable.join(', ')}. evals/golden is written by people (N7); proposals wait in evals/proposals (use --source proposal).`,
    );
    return 0;
  }

  const maxCalls = Number(values['max-calls']);
  if (!Number.isInteger(maxCalls) || maxCalls < 1)
    throw new EvalSetupError('--max-calls wants a whole number');
  const rig = createRig({
    provider: kind,
    maxCalls,
    env: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const results = await runEval({
    cases,
    rig,
    agents: list<EvalAgent>(values.agent, EVAL_AGENTS, 'agent'),
    pins,
    allVersions: values['all-versions'],
  });
  const report = buildReport(kind, results);

  let comparison;
  if (values.baseline !== undefined) {
    comparison = compareReports(
      report,
      parseBaseline(JSON.parse(readFileSync(values.baseline, 'utf8'))),
    );
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report, comparison));
  if (!values['no-write']) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  const minRate = Number(values['min-pass-rate']);
  const below = report.summary.filter((row) => row.passRate < minRate);
  if (below.length > 0) {
    console.error(
      `eval: ${String(below.length)} prompt version(s) under the pass rate ${String(minRate)}`,
    );
    return 1;
  }
  if (comparison !== undefined && comparison.regressions.length > 0) return 1;
  return 0;
}

/** Recall and false positives of the redactor on made-up text (T-302e). Needs no key and no network. */
function redaction(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: 'boolean', default: false },
      corpus: { type: 'string', default: join(EVALS, 'runner', 'redaction', 'corpus.json') },
      ner: { type: 'string', default: 'off' },
      'min-recall': { type: 'string', default: '1' },
      'max-false-positive': { type: 'string', default: '0.02' },
    },
  });
  const corpus = redactionCorpusSchema.parse(JSON.parse(readFileSync(values.corpus, 'utf8')));
  if (values.ner !== 'off' && values.ner !== 'local') {
    throw new EvalSetupError(`unknown --ner: ${values.ner} (off or local)`);
  }
  const nameFinder = values.ner === 'local' ? createLocalNameFinder() : null;
  const redactor: RedactFn = (text, names) =>
    createRedactor({ names: () => names, nameFinder })
      .session({ scope: 'eval:redaction' })
      .redact(text);
  const report = evaluateRedaction(`createRedactor() ner=${values.ner}`, corpus.cases, redactor);
  console.log(values.json ? JSON.stringify(report, null, 2) : formatRedactionReport(report));
  const problems = redactionGate(report, {
    minRecall: Number(values['min-recall']),
    maxFalsePositive: Number(values['max-false-positive']),
  });
  for (const problem of problems) console.error(`redaction eval: ${problem}`);
  return problems.length > 0 ? 1 : 0;
}

/** Recall and noise per similarity floor of the KB search, with a real local embedder (T-431). */
async function kbSimilarity(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      url: { type: 'string', default: process.env.EMBEDDING_LOCAL_URL ?? 'http://127.0.0.1:11434' },
      model: { type: 'string', default: process.env.EMBEDDING_MODEL ?? 'bge-m3' },
      'kb-dir': { type: 'string', default: join(ROOT, 'examples', 'kb') },
      queries: { type: 'string', default: join(EVALS, 'runner', 'kb-similarity', 'queries.json') },
      fake: { type: 'boolean', default: false },
    },
  });
  const querySet = kbQuerySetSchema.parse(JSON.parse(readFileSync(values.queries, 'utf8')));
  const provider: EmbeddingProvider = values.fake
    ? new MockEmbeddingProvider(32)
    : createLocalEmbeddingProvider({
        url: values.url,
        fetch: (input, init) => globalThis.fetch(input, init),
        timeoutMs: 120_000,
      });
  const { report, passages } = await runKbSimilarity({
    kbDir: values['kb-dir'],
    querySet,
    provider,
    model: values.model,
  });
  console.log(formatSimilarityReport(values.fake ? 'fake vectors' : values.model, report));
  console.log(`(${String(passages)} passages of ${values['kb-dir']})`);
  return 0;
}

async function replay(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: 'string', default: '30' },
      limit: { type: 'string', default: '50' },
      out: { type: 'string', default: join(SOURCE_DIRS.replay, 'replay.json') },
    },
  });
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new EvalSetupError('DATABASE_URL is not set (a read-only login is best) [ASK-HUMAN]');
  }
  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-eval-replay' });
  const exported = await exportReplay({
    database,
    days: Number(values.days),
    limit: Number(values.limit),
  });
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(exported.cases, null, 2)}\n`);
  console.log(
    `replay: ${String(exported.cases.length)} case(s) from ${String(exported.tickets)} ticket(s) (${String(exported.skipped)} skipped) -> ${values.out}`,
  );
  console.log(
    'The file is redacted but is ticket text: it stays in the git-ignored evals/.replay.',
  );
  await database.close();
  return 0;
}

/** A procedure version on made-up cases and tools, the engine the worker runs on real tickets (T-303d). */
async function simulate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      steps: { type: 'string' },
      baseline: { type: 'string' },
      cases: { type: 'string', default: join(EVALS, 'runner', 'simulation', 'smoke.json') },
      provider: { type: 'string', default: process.env.EVAL_PROVIDER ?? 'mock' },
      'max-calls': { type: 'string', default: '200' },
      json: { type: 'boolean', default: false },
    },
  });
  if (values.steps === undefined) throw new EvalSetupError('--steps wants the file of the steps');
  const provider = values.provider;
  if (provider !== 'mock' && provider !== 'claude-cli') {
    throw new EvalSetupError(`unknown provider: ${provider} (mock or claude-cli)`);
  }
  const maxCalls = Number(values['max-calls']);
  if (!Number.isInteger(maxCalls) || maxCalls < 1)
    throw new EvalSetupError('--max-calls wants a whole number');
  const fixture = simulationFixtureSchema.parse(JSON.parse(readFileSync(values.cases, 'utf8')));
  const rig = createRig({
    provider,
    maxCalls,
    env: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const outcome = await simulateFixture({
    rig,
    cases: fixture.cases,
    steps: parseStepsFile(JSON.parse(readFileSync(values.steps, 'utf8'))),
    baselineSteps:
      values.baseline === undefined
        ? undefined
        : parseStepsFile(JSON.parse(readFileSync(values.baseline, 'utf8'))),
  });
  console.log(values.json ? JSON.stringify(outcome, null, 2) : formatSimulation(outcome));
  return outcome.status === 'ok' && outcome.passed ? 0 : 1;
}

/** Replays the set in force for an intent and records the result for the gate (T-306g). */
async function record(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      intent: { type: 'string' },
      as: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      provider: { type: 'string', default: process.env.AI_PROVIDER ?? 'mock' },
      'max-calls': { type: 'string', default: '100' },
      days: { type: 'string', default: '90' },
      limit: { type: 'string', default: '30' },
      corpus: { type: 'string', default: join(EVALS, 'runner', 'redaction', 'corpus.json') },
    },
  });
  if (values.intent === undefined || values.as === undefined) {
    throw new EvalSetupError('record wants --intent <key> and --as <email>');
  }
  const provider = values.provider;
  if (provider !== 'mock' && provider !== 'claude-cli') {
    throw new EvalSetupError(`unknown provider: ${provider} (mock or claude-cli)`);
  }
  const maxCalls = Number(values['max-calls']);
  if (!Number.isInteger(maxCalls) || maxCalls < 1)
    throw new EvalSetupError('--max-calls wants a whole number');
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new EvalSetupError('DATABASE_URL is not set (the application login) [ASK-HUMAN]');
  }
  const corpus = redactionCorpusSchema.parse(JSON.parse(readFileSync(values.corpus, 'utf8')));
  const rig = createRig({
    provider,
    maxCalls,
    env: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const database = createDatabase({ url, max: 2, applicationName: 'watchtower-eval-record' });
  try {
    const outcome = await recordReplay({
      database,
      rig,
      intentKey: values.intent,
      actorEmail: values.as,
      days: Number(values.days),
      limit: Number(values.limit),
      dryRun: values['dry-run'],
      redactionCorpus: corpus.cases,
    });
    console.log(formatRecord(outcome));
    return 0;
  } finally {
    await database.close();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === undefined || command === 'run') return await run(command === 'run' ? rest : []);
    if (command === 'simulate') return await simulate(rest);
    if (command === 'redaction') return redaction(rest);
    if (command === 'kb-similarity') return await kbSimilarity(rest);
    if (command === 'record') return await record(rest);
    if (command === 'replay') return await replay(rest);
    console.log(USAGE);
    return command === 'help' || command === '--help' ? 0 : 1;
  } catch (error) {
    if (error instanceof EvalSetupError) {
      console.error(`eval: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main();
