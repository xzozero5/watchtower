import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Brings the stack up before the first test and tears it down after the last.
 *
 * - default (`E2E_STACK=spawn`): runs tools/e2e-stack/up.mjs, which builds a throwaway database and
 *   starts api, worker and web from the build output on loopback ports of their own.
 * - `E2E_STACK=external`: uses a stack that is already running (docker compose); the URLs and the
 *   break-glass account come from E2E_WEB_URL, E2E_API_URL, E2E_MAILPIT_URL, E2E_BREAK_GLASS_EMAIL
 *   and E2E_BREAK_GLASS_PASSWORD.
 *
 * The tests read the result from process.env (workers inherit it). Secrets are never printed.
 */
const READY_TIMEOUT_MS = 120_000;

interface StackState {
  webUrl: string;
  apiUrl: string;
  mailpitUrl: string;
  breakGlassEmail: string;
  breakGlassPassword: string;
  logDir: string;
  /** Extra E2E_* variables the stack made for the tests (mock integration secrets, log files). */
  env?: Record<string, string>;
}

function publish(state: StackState): void {
  process.env.E2E_WEB_URL = state.webUrl;
  process.env.E2E_API_URL = state.apiUrl;
  process.env.E2E_MAILPIT_URL = state.mailpitUrl;
  process.env.E2E_BREAK_GLASS_EMAIL = state.breakGlassEmail;
  process.env.E2E_BREAK_GLASS_PASSWORD = state.breakGlassPassword;
  process.env.E2E_STACK_LOG_DIR = state.logDir;
  for (const [name, value] of Object.entries(state.env ?? {})) {
    if (name.startsWith('E2E_')) process.env[name] = value;
  }
}

function external(): StackState {
  const need = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`E2E_STACK=external needs ${name}`);
    return value;
  };
  return {
    webUrl: need('E2E_WEB_URL').replace(/\/+$/, ''),
    apiUrl: need('E2E_API_URL').replace(/\/+$/, ''),
    mailpitUrl: (process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8025').replace(/\/+$/, ''),
    breakGlassEmail: need('E2E_BREAK_GLASS_EMAIL'),
    breakGlassPassword: need('E2E_BREAK_GLASS_PASSWORD'),
    logDir: '',
  };
}

function waitForReady(child: ChildProcess, stateFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(
        new Error(
          `the stack was not ready in ${String(READY_TIMEOUT_MS / 1000)} s:\n${output.slice(-2000)}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(`READY ${stateFile}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the stack exited with ${String(code)} before it was ready:\n${output.slice(-2000)}`,
        ),
      );
    });
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_STACK === 'external') {
    publish(external());
    return () => Promise.resolve();
  }

  const script = fileURLToPath(new URL('../../../tools/e2e-stack/up.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'wt-e2e-state-'));
  const stateFile = join(dir, 'state.json');
  // stdin stays open: when this process dies the stack sees it close and tears itself down.
  const childEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key.startsWith('E2E_') && key !== 'E2E_STACK' && value !== undefined,
      ),
    ),
    ...(process.env.TEST_DATABASE_URL ? { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL } : {}),
  };
  const child: ChildProcess = spawn(process.execPath, [script, '--state', stateFile], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv,
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
  });

  try {
    await waitForReady(child, stateFile);
  } catch (error) {
    child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  publish(JSON.parse(readFileSync(stateFile, 'utf8')) as StackState);
  rmSync(dir, { recursive: true, force: true });

  return async () => {
    child.kill('SIGTERM');
    await exited;
  };
}
