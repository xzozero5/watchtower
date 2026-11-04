import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createDatabase } from '@watchtower/db';

import { EVAL_AGENTS, EVAL_SOURCES, type EvalAgent, type EvalSource } from './case.js';
import { runEval } from './eval.js';
import { loadCases, type CaseDir } from './load.js';
import { exportReplay } from './replay.js';
import { buildReport, compareReports, formatReport, parseBaseline } from './report.js';
import { createRig, EvalSetupError, type EvalProviderKind } from './rig.js';

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
  --agent classifier,drafter,grader,kb_author
  --prompt grader=2              pin a prompt version (repeatable); the rest run at their latest
  --all-versions                 run every case at every version of its prompt
  --baseline path.json           compare with an earlier report; a case that passed and now fails is a regression
  --out path.json                where to write the report (default evals/reports/latest.json; --no-write to skip)
  --min-pass-rate 1              exit 1 when any prompt version passes less often (default 1)
  --max-calls 100                stop after this many model calls (the budget guard of the run)

  pnpm --filter @watchtower/eval-runner replay -- --days 30 --limit 50
    reads resolved tickets from DATABASE_URL, redacts them and writes evals/.replay/replay.json (git-ignored)
`;

function list<T extends string>(value: string | undefined, allowed: readonly T[], what: string): T[] {
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
    sources.length > 0 ? sources : kind === 'mock' ? ['golden', 'replay', 'smoke'] : ['golden', 'replay'];
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
  if (!Number.isInteger(maxCalls) || maxCalls < 1) throw new EvalSetupError('--max-calls wants a whole number');
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
    console.error(`eval: ${String(below.length)} prompt version(s) under the pass rate ${String(minRate)}`);
    return 1;
  }
  if (comparison !== undefined && comparison.regressions.length > 0) return 1;
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
  console.log('The file is redacted but is ticket text: it stays in the git-ignored evals/.replay.');
  await database.close();
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === undefined || command === 'run') return await run(command === 'run' ? rest : []);
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
