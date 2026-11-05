// Host-side bridge to the owner's CLI subscription (ADR-031).
// Dev/POC only. Plain Node, no dependencies. It never logs a prompt or a response body.
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const DEFAULT_PORT = 4317;
export const DEFAULT_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_CONCURRENCY = 4;
/** "Online" means the Anthropic API host accepts a TCP connection (ADR-019). */
export const ONLINE_CHECK_HOST = 'api.anthropic.com';
export const CODEX_ONLINE_CHECK_HOST = 'chatgpt.com';
export const ONLINE_CHECK_PORT = 443;
export const ONLINE_CHECK_TIMEOUT_MS = 3_000;
export const ONLINE_CACHE_MS = 15_000;
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

/** Never execute a Windows shell shim with model-controlled arguments. */
export function resolveCodexBinary(
  env = process.env,
  platform = process.platform,
  exists = existsSync,
) {
  const explicit = env.CODEX_CLI_BIN?.trim();
  if (explicit) {
    if (/\.(cmd|bat|ps1)$/i.test(explicit))
      throw new Error('CODEX_CLI_BIN must be a native executable');
    return explicit;
  }
  if (platform !== 'win32') return 'codex';
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const native = join(dir, 'codex.exe');
    if (exists(native)) return native;
  }
  throw new Error('codex.exe was not found on PATH; set CODEX_CLI_BIN');
}

/** A new CLI version may add a tool surface; never silently trust an upgrade. */
export function assertCodexVersion(bin, env = process.env, exec = execFileSync) {
  const version = exec(bin, ['--version'], {
    env: childEnv(env, undefined, 'codex'),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
  if (version !== 'codex-cli 0.166.0-alpha.5.1')
    throw new Error('unsupported Codex CLI version; isolation must be reverified');
  return version;
}

/** Kept fail-closed until the installed CLI's model-facing tool surface is verified. */
export function buildCodexArgs({ model }, { catalogPath, instructionsPath } = {}) {
  if (!catalogPath || !instructionsPath)
    throw new BridgeHttpError(503, 'codex_isolation_unverified');
  return [
    '--strict-config',
    '--no-daemon',
    '-a',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--model',
    model,
    '-c',
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    '-c',
    `model_instructions_file=${JSON.stringify(instructionsPath)}`,
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'web_search="disabled"',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.view_image=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.browser_use=false',
    '-c',
    'features.computer_use=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'features.memories=false',
    '-c',
    'features.hooks=false',
    '-c',
    'features.remote_plugin=false',
    '-c',
    'features.code_mode=false',
    '-c',
    'features.code_mode_host=false',
    '-c',
    'features.code_mode_tool_search=false',
    '-c',
    'features.deferred_executor=false',
    '-c',
    'features.send_message_to_user_async=false',
    '-c',
    'features.request_permissions_tool=false',
    '-c',
    'features.token_budget=false',
    '-c',
    'features.current_time_reminder=false',
    '-c',
    'features.sleep_tool=false',
    '-c',
    'features.tool_suggest=false',
    '-c',
    'features.artifact=false',
    '-c',
    'features.agent_message_board=false',
    '-c',
    'features.goals=false',
    '-c',
    'features.multi_agent_v2=false',
    '-c',
    'features.multi_agent_v2_dynamic_tools=false',
    '-c',
    'features.skill_search=false',
    '-c',
    'features.skill_mcp_dependency_install=false',
    '-c',
    'tools.update_plan.enabled=false',
    '-c',
    'analytics.enabled=false',
    '-c',
    'feedback.enabled=false',
    '-',
  ];
}

/** Preserve trusted model sizing/capabilities, but remove every model-owned tool definition. */
export function buildIsolatedCatalog(catalog, model) {
  const metadata = catalog?.models?.find((item) => item.slug === model);
  if (!metadata) throw new BridgeHttpError(503, 'codex_model_unavailable');
  return {
    models: [
      {
        ...metadata,
        shell_type: 'disabled',
        apply_patch_tool_type: null,
        tool_mode: 'direct',
        experimental_supported_tools: [],
        supports_search_tool: false,
        node_repl_disabled: true,
        model_messages: null,
        base_instructions: '',
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: false,
      },
    ],
  };
}

export async function prepareCodexIsolation(cwd, model, env = process.env, system = '') {
  const codexHome = env.CODEX_HOME ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), '.codex');
  let source;
  try {
    source = JSON.parse(await readFile(join(codexHome, 'models_cache.json'), 'utf8'));
  } catch {
    throw new BridgeHttpError(503, 'codex_catalog_unavailable');
  }
  const catalogPath = join(cwd, 'models.json');
  const instructionsPath = join(cwd, 'instructions.md');
  await writeFile(catalogPath, JSON.stringify(buildIsolatedCatalog(source, model)), {
    mode: 0o600,
  });
  await writeFile(instructionsPath, `You have no tools or external access.\n\n${system}`, {
    mode: 0o600,
  });
  return { catalogPath, instructionsPath };
}

/** Codex JSONL is accepted only when one text response has completed with measured usage. */
export function parseCodexOutput(stdout, requestedModel) {
  let events;
  try {
    events = stdout
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return null;
  }
  let text;
  let usage;
  let completed = false;
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string' || completed)
      return null;
    if (event.type === 'thread.started' || event.type === 'turn.started') continue;
    if (
      event.type === 'item.started' ||
      event.type === 'item.updated' ||
      event.type === 'item.completed'
    ) {
      const item = event.item;
      if (!item || !['agent_message', 'reasoning'].includes(item.type)) return null;
      if (item.type === 'agent_message' && event.type === 'item.completed') {
        if (text !== undefined || typeof item.text !== 'string') return null;
        text = item.text;
      }
      continue;
    }
    if (event.type !== 'turn.completed') return null;
    usage = event.usage;
    if (
      !usage ||
      !Number.isSafeInteger(usage.input_tokens) ||
      usage.input_tokens < 0 ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.output_tokens < 0 ||
      (usage.cached_input_tokens !== undefined &&
        (!Number.isSafeInteger(usage.cached_input_tokens) ||
          usage.cached_input_tokens < 0 ||
          usage.cached_input_tokens > usage.input_tokens))
    )
      return null;
    completed = true;
  }
  if (!completed || text === undefined) return null;
  return {
    text,
    model: requestedModel,
    finishReason: 'stop',
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
  };
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
export function buildStdin({ system, messages }, mode = 'claude') {
  const parts = [];
  if (system && mode !== 'codex' && system.length > MAX_SYSTEM_ARG_CHARS) {
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
  const { model, system, messages, maxOutputTokens, backend } = body;
  if (backend !== undefined && backend !== 'claude' && backend !== 'codex') {
    throw new BridgeHttpError(400, 'bad_backend');
  }
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
  return { model, system, messages, maxOutputTokens, backend };
}

/** One TCP connect attempt; resolves true when the port accepts, false on error or timeout. */
export function tcpReachable(host, port, timeoutMs, connect = netConnect) {
  return new Promise((resolve) => {
    let socket;
    const finish = (ok) => {
      socket?.destroy();
      resolve(ok);
    };
    try {
      socket = connect({ host, port });
    } catch {
      resolve(false);
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * A cached "is the internet (Anthropic) reachable" check. The result lives `ttlMs`; concurrent
 * callers share one probe. `probe` is injectable so tests never touch the network.
 */
export function createOnlineChecker({
  mode = 'claude',
  probe = () =>
    tcpReachable(
      mode === 'codex' ? CODEX_ONLINE_CHECK_HOST : ONLINE_CHECK_HOST,
      ONLINE_CHECK_PORT,
      ONLINE_CHECK_TIMEOUT_MS,
    ),
  ttlMs = ONLINE_CACHE_MS,
  now = Date.now,
} = {}) {
  let last = null; // { online, at }
  let inflight = null;
  return async function checkOnline() {
    if (last !== null && now() - last.at < ttlMs) return { ...last };
    inflight ??= probe()
      .catch(() => false)
      .then((online) => {
        last = { online: online === true, at: now() };
        return last;
      })
      .finally(() => {
        inflight = null;
      });
    return { ...(await inflight) };
  };
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

export function childEnv(env, maxOutputTokens, mode = 'claude') {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'PATHEXT',
    ...(mode === 'claude' ? ['CLAUDE_CODE_OAUTH_TOKEN'] : ['CODEX_HOME']),
  ]);
  const next = Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key.toUpperCase())),
  );
  if (mode === 'claude' && maxOutputTokens !== undefined)
    next.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  return next;
}

/**
 * Runs one `claude -p`. stderr is read and dropped: it can echo the prompt. `clientGone` is aborted when
 * the caller closed the connection before the answer (the api gave up: the person closed the page, or
 * the api's own timeout): the child is killed at once, so an abandoned request does not keep a model
 * call and a slot busy until the timeout (T-155a C-7).
 */
async function runCli({
  bin,
  request,
  spawn,
  timeoutMs,
  env,
  makeTempDir,
  removeDir,
  clientGone,
  mode,
  prepareIsolation,
}) {
  const cwd = await makeTempDir();
  try {
    const args =
      mode === 'codex'
        ? buildCodexArgs(request, await prepareIsolation(cwd, request.model, env, request.system))
        : buildCliArgs(request);
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        env: childEnv(env, request.maxOutputTokens, mode),
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
        clientGone?.removeEventListener('abort', onClientGone);
        fn(value);
      };
      const onClientGone = () => {
        child.kill('SIGKILL');
        finish(reject, new BridgeHttpError(499, 'client_closed'));
      };
      if (clientGone?.aborted === true) {
        queueMicrotask(onClientGone);
      } else {
        clientGone?.addEventListener('abort', onClientGone, { once: true });
      }
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
        const parsed =
          mode === 'codex'
            ? parseCodexOutput(out, request.model)
            : parseCliOutput(out, request.model);
        if (parsed === null) return finish(reject, new BridgeHttpError(502, 'cli_failed'));
        finish(resolve, parsed);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(buildStdin(request, mode));
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
  mode = 'claude',
  bin = mode === 'codex' ? 'codex' : 'claude',
  prepareIsolation = prepareCodexIsolation,
  spawn = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  env = process.env,
  log = () => {},
  checkOnline = createOnlineChecker({ mode }),
  makeTempDir = () => mkdtemp(join(tmpdir(), 'wt-ai-bridge-')),
  removeDir = (dir) => rm(dir, { recursive: true, force: true }),
}) {
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('AI_BRIDGE_TOKEN must be set to at least 16 characters');
  }
  if (!['claude', 'codex'].includes(mode))
    throw new Error('AI_BRIDGE_MODE must be claude or codex');
  let active = 0;
  const send = (res, status, body) => {
    // The caller is gone (or the answer is already out): nothing to write to.
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    const started = Date.now();
    const done = (status, extra = {}) => log({ status, ms: Date.now() - started, ...extra });
    // `close` on the response without a finished answer = the caller dropped the connection.
    const clientGone = new AbortController();
    res.once('close', () => {
      if (!res.writableFinished) clientGone.abort();
    });
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/healthz') {
          // No auth, and nothing but liveness and reachability: no version, path, model or token.
          const { online, at } = await checkOnline();
          send(res, 200, { status: 'ok', online, checkedAt: new Date(at).toISOString() });
          done(200, { route: 'healthz', online });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/generate') {
          throw new BridgeHttpError(404, 'not_found');
        }
        if (!tokenMatches(req.headers.authorization, token)) {
          throw new BridgeHttpError(401, 'unauthorized');
        }
        const request = validateRequest(await readBody(req));
        if (request.backend !== undefined && request.backend !== mode)
          throw new BridgeHttpError(409, 'backend_mismatch');
        // AI works only while this host is online (ADR-019): say so instead of spawning a doomed CLI.
        if (!(await checkOnline()).online) throw new BridgeHttpError(503, 'offline');
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
            clientGone: clientGone.signal,
            mode,
            prepareIsolation,
          });
          send(res, 200, { ...result, backend: mode });
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
