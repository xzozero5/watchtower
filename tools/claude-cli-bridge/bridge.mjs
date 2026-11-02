// Host-side bridge from the worker (inside Docker) to the owner's local `claude -p` (ADR-017).
// Dev/POC only. Plain Node, no dependencies. It never logs a prompt or a response body.
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const DEFAULT_PORT = 4317;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_CONCURRENCY = 2;
export const MAX_REQUEST_BYTES = 1_000_000;
export const MAX_OUTPUT_BYTES = 4_000_000;
/** A system prompt longer than this goes to stdin: the Windows command line is limited to ~32k. */
export const MAX_SYSTEM_ARG_CHARS = 12_000;

/** Aliases (`opus`) and full ids both match. Must start with a letter or digit: never a flag. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export class BridgeHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** Finds a real executable. A `.cmd` shim cannot be spawned without a shell, and a shell would
 * put model-controlled text on a command line, so Windows resolves the native binary instead. */
export function resolveClaudeBinary(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  const explicit = env.CLAUDE_CLI_BIN?.trim();
  if (explicit) {
    if (/\.(cmd|bat)$/i.test(explicit)) {
      throw new Error('CLAUDE_CLI_BIN must be an executable, not a .cmd or .bat shim');
    }
    return explicit;
  }
  if (platform !== 'win32') return 'claude';
  const pathText = env.PATH ?? env.Path ?? '';
  for (const dir of pathText.split(delimiter).filter(Boolean)) {
    if (!exists(join(dir, 'claude.cmd'))) continue;
    const native = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exists(native)) return native;
  }
  throw new Error('claude.exe was not found next to claude.cmd on PATH; set CLAUDE_CLI_BIN');
}

/** The argument list for `claude -p`. Every tool is off; nothing is loaded from the machine. */
export function buildCliArgs({ model, system }) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    // An empty list disables every built-in tool (`claude --help`, --tools).
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    // The working directory is an empty temp dir, so "project" settings are empty by construction.
    '--setting-sources',
    'project',
  ];
  if (system && system.length <= MAX_SYSTEM_ARG_CHARS) args.push('--system-prompt', system);
  return args;
}

/** What goes to stdin: the conversation, plus the system prompt when it is too long for argv. */
export function buildStdin({ system, messages }) {
  const parts = [];
  if (system && system.length > MAX_SYSTEM_ARG_CHARS) {
    parts.push(`<instructions>\n${system}\n</instructions>`);
  }
  if (messages.length === 1 && messages[0].role === 'user') {
    parts.push(messages[0].content);
  } else {
    parts.push(
      messages
        .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
        .join('\n\n'),
    );
    parts.push('Assistant:');
  }
  return parts.join('\n\n');
}

export function validateRequest(body) {
  if (typeof body !== 'object' || body === null) throw new BridgeHttpError(400, 'bad_request');
  const { model, system, messages, maxOutputTokens } = body;
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new BridgeHttpError(400, 'bad_model');
  }
  if (typeof system !== 'string') throw new BridgeHttpError(400, 'bad_request');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 50) {
    throw new BridgeHttpError(400, 'bad_request');
  }
  for (const m of messages) {
    if (
      typeof m !== 'object' ||
      m === null ||
      (m.role !== 'user' && m.role !== 'assistant') ||
      typeof m.content !== 'string'
    ) {
      throw new BridgeHttpError(400, 'bad_request');
    }
  }
  if (
    maxOutputTokens !== undefined &&
    !(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 && maxOutputTokens <= 200_000)
  ) {
    throw new BridgeHttpError(400, 'bad_request');
  }
  return { model, system, messages, maxOutputTokens };
}

const sha = (text) => createHash('sha256').update(text).digest();

export function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(sha(header.slice(7)), sha(token));
}

/** Reads the JSON `claude -p --output-format json` printed. Returns null if it is not a success. */
export function parseCliOutput(stdout, requestedModel) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  // `--output-format json` prints one result object (older builds may print an array of events).
  if (Array.isArray(data)) data = data.findLast((e) => e && e.type === 'result');
  if (!data || typeof data !== 'object' || data.is_error === true) return null;
  if (typeof data.result !== 'string') return null;
  const usage = data.usage ?? {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
  // Cache reads and writes are input the model saw, so they count toward the input tokens.
  const inputTokens =
    n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
  const modelIds =
    data.modelUsage && typeof data.modelUsage === 'object' ? Object.keys(data.modelUsage) : [];
  const finishReason =
    data.subtype === 'error_max_turns' || data.stop_reason === 'max_tokens' ? 'length' : 'stop';
  return {
    text: data.result,
    model: modelIds[0] ?? requestedModel,
    finishReason,
    usage: { inputTokens, outputTokens: n(usage.output_tokens) },
  };
}

function childEnv(env, maxOutputTokens) {
  const next = { ...env };
  // The point is the subscription login: an API key in the environment would bill the key instead.
  delete next.ANTHROPIC_API_KEY;
  delete next.ANTHROPIC_AUTH_TOKEN;
  delete next.CLAUDE_CLI_BRIDGE_TOKEN;
  if (maxOutputTokens !== undefined) next.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return next;
}

/** Runs one `claude -p`. stderr is read and dropped: it can echo the prompt. */
async function runCli({ bin, request, spawn, timeoutMs, env, makeTempDir, removeDir }) {
  const cwd = await makeTempDir();
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, buildCliArgs(request), {
        cwd,
        env: childEnv(env, request.maxOutputTokens),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
      let out = '';
      let bytes = 0;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new BridgeHttpError(504, 'timeout'));
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish(reject, new BridgeHttpError(502, 'output_too_large'));
          return;
        }
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', () => {});
      child.on('error', () => finish(reject, new BridgeHttpError(502, 'spawn_failed')));
      child.on('close', (code) => {
        if (code !== 0) return finish(reject, new BridgeHttpError(502, 'cli_failed'));
        const parsed = parseCliOutput(out, request.model);
        if (parsed === null) return finish(reject, new BridgeHttpError(502, 'cli_failed'));
        finish(resolve, parsed);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(buildStdin(request));
    });
  } finally {
    await removeDir(cwd).catch(() => {});
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new BridgeHttpError(413, 'too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeHttpError(400, 'bad_request');
  }
}

/**
 * The HTTP server. `log` receives metadata only (status, latency, model, token counts), never text.
 * `spawn`, `makeTempDir` and `removeDir` are injectable so tests never start the real binary.
 */
export function createBridge({
  token,
  bin = 'claude',
  spawn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  env = process.env,
  log = () => {},
  makeTempDir = () => mkdtemp(join(tmpdir(), 'wt-claude-bridge-')),
  removeDir = (dir) => rm(dir, { recursive: true, force: true }),
}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('CLAUDE_CLI_BRIDGE_TOKEN must be set to at least 16 characters');
  }
  let active = 0;
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    const started = Date.now();
    const done = (status, extra = {}) => log({ status, ms: Date.now() - started, ...extra });
    void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/generate') {
          throw new BridgeHttpError(404, 'not_found');
        }
        if (!tokenMatches(req.headers.authorization, token)) {
          throw new BridgeHttpError(401, 'unauthorized');
        }
        const request = validateRequest(await readBody(req));
        if (active >= maxConcurrency) throw new BridgeHttpError(429, 'busy');
        active += 1;
        try {
          const result = await runCli({
            bin,
            request,
            spawn,
            timeoutMs,
            env,
            makeTempDir,
            removeDir,
          });
          send(res, 200, result);
          done(200, {
            model: result.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          });
        } finally {
          active -= 1;
        }
      } catch (error) {
        const status = error instanceof BridgeHttpError ? error.status : 500;
        const code = error instanceof BridgeHttpError ? error.code : 'internal';
        send(res, status, { error: code });
        done(status, { error: code });
      }
    })();
  });
}
