import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCliArgs,
  buildStdin,
  buildCodexArgs,
  parseCodexOutput,
  childEnv,
  buildIsolatedCatalog,
  assertCodexVersion,
  prepareCodexIsolation,
  createBridge,
  createOnlineChecker,
  parseCliOutput,
  tcpReachable,
  resolveClaudeBinary,
  resolveCodexBinary,
  tokenMatches,
} from './bridge.mjs';
import { readBridgeConfig } from './server.mjs';

// Made-up values, not credentials.
const TOKEN = 'test-bridge-token-0123456789';
const SECRET_PROMPT = 'PROMPT-BODY-MUST-NOT-BE-LOGGED';
const SECRET_ANSWER = 'ANSWER-BODY-MUST-NOT-BE-LOGGED';

const cliJson = (overrides = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: SECRET_ANSWER,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 2,
      output_tokens: 7,
    },
    modelUsage: { 'reported-model': {} },
    ...overrides,
  });

/** A fake `spawn`: records the call and plays a scripted child. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (bin, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    const call = { bin, args, options, stdin: '' };
    child.stdin.on('data', (c) => {
      call.stdin += c.toString();
    });
    calls.push(call);
    queueMicrotask(() => script(child, call));
    return child;
  };
  return { spawn, calls };
}

const succeed =
  (stdout = cliJson()) =>
  (child) => {
    child.stdin.on('finish', () => {
      child.stdout.write(stdout);
      child.emit('close', 0);
    });
  };

let server;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function start(options) {
  const logs = [];
  server = createBridge({
    token: TOKEN,
    env: { PATH: 'x', ANTHROPIC_API_KEY: 'k', CLAUDE_CLI_BRIDGE_TOKEN: TOKEN },
    makeTempDir: () => Promise.resolve('/tmp/fake-cwd'),
    removeDir: () => Promise.resolve(),
    log: (entry) => logs.push(entry),
    // Never the real network in tests.
    checkOnline: () => Promise.resolve({ online: true, at: Date.now() }),
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${String(server.address().port)}`;
  const url = `${base}/v1/generate`;
  const post = (body, token = TOKEN) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { post, logs, url, base };
}

const goodBody = {
  model: 'sonnet',
  system: 'You classify.',
  messages: [{ role: 'user', content: SECRET_PROMPT }],
};

const codexJson = (usage = { input_tokens: 13, cached_input_tokens: 5, output_tokens: 7 }) =>
  [
    { type: 'thread.started', thread_id: 'synthetic' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: SECRET_ANSWER } },
    { type: 'turn.completed', usage },
  ]
    .map((item) => JSON.stringify(item))
    .join('\n');

describe('Codex backend', () => {
  it('writes an isolated model catalog and high-priority system instructions into the request temp directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wt-ai-bridge-test-'));
    try {
      const codexHome = join(dir, 'codex-home');
      await mkdir(codexHome);
      await writeFile(
        join(codexHome, 'models_cache.json'),
        JSON.stringify({
          identity: 'not-forwarded',
          models: [
            {
              slug: 'test-model',
              shell_type: 'unified_exec',
              apply_patch_tool_type: 'freeform',
              context_window: 10000,
            },
          ],
        }),
      );
      const files = await prepareCodexIsolation(
        dir,
        'test-model',
        { CODEX_HOME: codexHome },
        'SYSTEM-PRIORITY-TEXT',
      );
      const catalog = JSON.parse(await readFile(files.catalogPath, 'utf8'));
      expect(catalog).not.toHaveProperty('identity');
      expect(catalog.models[0]).toMatchObject({
        slug: 'test-model',
        apply_patch_tool_type: null,
        shell_type: 'disabled',
        context_window: 10000,
      });
      expect(await readFile(files.instructionsPath, 'utf8')).toContain('SYSTEM-PRIORITY-TEXT');
      await expect(
        prepareCodexIsolation(dir, 'missing-model', { CODEX_HOME: codexHome }),
      ).rejects.toMatchObject({ code: 'codex_model_unavailable' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses unsupported CLI versions instead of silently exposing future tools', () => {
    expect(assertCodexVersion('codex', {}, () => 'codex-cli 0.166.0-alpha.5.1\n')).toBe(
      'codex-cli 0.166.0-alpha.5.1',
    );
    expect(() => assertCodexVersion('codex', {}, () => 'codex-cli 0.999.0')).toThrow();
  });
  it('requires verified isolation and never puts customer text in argv', () => {
    expect(() => buildCodexArgs(goodBody)).toThrow();
    const args = buildCodexArgs(goodBody, {
      catalogPath: '/tmp/models.json',
      instructionsPath: '/tmp/instructions.md',
    });
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--strict-config');
    expect(args).toContain('read-only');
    expect(args.join(' ')).not.toContain(SECRET_PROMPT);
    expect(buildStdin(goodBody, 'codex')).not.toContain(goodBody.system);
    const source = {
      models: [
        {
          slug: 'test-model',
          context_window: 1000,
          apply_patch_tool_type: 'freeform',
          shell_type: 'unified_exec',
          model_messages: { instructions: 'untrusted tools' },
          experimental_supported_tools: ['clock'],
        },
      ],
    };
    const isolated = buildIsolatedCatalog(source, 'test-model').models[0];
    expect(isolated).toMatchObject({
      apply_patch_tool_type: null,
      shell_type: 'disabled',
      model_messages: null,
      experimental_supported_tools: [],
      context_window: 1000,
      tool_mode: 'direct',
    });
    expect(() => buildIsolatedCatalog(source, 'missing')).toThrow();
  });

  it('counts cached input once and rejects incomplete, failed, malformed or tool output', () => {
    expect(parseCodexOutput(codexJson(), 'test-model')).toEqual({
      text: SECRET_ANSWER,
      model: 'test-model',
      finishReason: 'stop',
      usage: { inputTokens: 13, outputTokens: 7 },
    });
    expect(parseCodexOutput(codexJson({ input_tokens: 1, output_tokens: -1 }), 'm')).toBeNull();
    expect(parseCodexOutput(codexJson({ input_tokens: 1.5, output_tokens: 3 }), 'm')).toBeNull();
    expect(parseCodexOutput(codexJson({ output_tokens: 3 }), 'm')).toBeNull();
    expect(parseCodexOutput(codexJson().split('\n').slice(0, -1).join('\n'), 'm')).toBeNull();
    expect(parseCodexOutput(`${codexJson()}\n{"type":"turn.failed"}`, 'm')).toBeNull();
    expect(parseCodexOutput(`${codexJson()}\ninvalid`, 'm')).toBeNull();
    expect(
      parseCodexOutput(codexJson().replace('agent_message', 'command_execution'), 'm'),
    ).toBeNull();
  });

  it('rejects backend mismatch before spawning and returns the selected backend', async () => {
    const { spawn, calls } = fakeSpawn(succeed(codexJson()));
    const { post } = await start({
      mode: 'codex',
      prepareIsolation: async () => ({
        catalogPath: '/tmp/models.json',
        instructionsPath: '/tmp/instructions.md',
      }),
      spawn,
      bin: 'codex-bin',
    });
    expect((await post({ ...goodBody, backend: 'claude' })).status).toBe(409);
    expect(calls).toHaveLength(0);
    const response = await post({ ...goodBody, backend: 'codex' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      backend: 'codex',
      usage: { inputTokens: 13, outputTokens: 7 },
    });
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].stdin).not.toContain(goodBody.system);
  });

  it('does not spawn an unverified Codex invocation', async () => {
    const { spawn, calls } = fakeSpawn(succeed(codexJson()));
    const { post } = await start({
      mode: 'codex',
      spawn,
      prepareIsolation: async () => {
        throw new Error('unavailable');
      },
    });
    expect((await post(goodBody)).status).toBe(500);
    expect(calls).toHaveLength(0);
  });

  it('passes only runtime and subscription auth to CLI children', () => {
    const env = {
      PATH: 'bin',
      USERPROFILE: 'profile',
      CODEX_HOME: 'auth-home',
      OPENAI_API_KEY: 'key',
      CODEX_API_KEY: 'key2',
      DATABASE_URL: 'db',
      GITHUB_TOKEN: 'git',
      AI_BRIDGE_TOKEN: TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    };
    expect(childEnv(env, 10, 'codex')).toEqual({
      PATH: 'bin',
      USERPROFILE: 'profile',
      CODEX_HOME: 'auth-home',
    });
    expect(childEnv(env, 10, 'claude')).toEqual({
      PATH: 'bin',
      USERPROFILE: 'profile',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '10',
    });
    expect(resolveCodexBinary({ PATH: 'native' }, 'win32', (p) => p.endsWith('codex.exe'))).toMatch(
      /codex\.exe$/,
    );
    expect(() => resolveCodexBinary({ CODEX_CLI_BIN: 'codex.cmd' })).toThrow();
  });

  it('defaults the canonical runner to Codex, keeps legacy Claude and gives canonical env precedence', () => {
    expect(readBridgeConfig({}).mode).toBe('codex');
    expect(readBridgeConfig({ AI_BRIDGE_MODE: 'codex' }, { legacy: true }).mode).toBe('claude');
    expect(
      readBridgeConfig({ AI_BRIDGE_TOKEN: 'canonical', CLAUDE_CLI_BRIDGE_TOKEN: 'legacy' }).token,
    ).toBe('canonical');
    expect(
      readBridgeConfig({ AI_BRIDGE_TOKEN: ' ', CLAUDE_CLI_BRIDGE_TOKEN: 'legacy' }).token,
    ).toBe('legacy');
    expect(() => readBridgeConfig({ AI_BRIDGE_MODE: 'other' })).toThrow();
    expect(() => readBridgeConfig({ NODE_ENV: 'production' })).toThrow();
    expect(() => readBridgeConfig({ AI_BRIDGE_PORT: '0' })).toThrow();
  });
});

describe('argument building', () => {
  it('disables all tools, sessions, MCP and slash commands, and passes the model and system prompt', () => {
    const args = buildCliArgs({ model: 'opus', system: 'sys' });
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'json',
        '--model',
        'opus',
        '--strict-mcp-config',
      ]),
    );
    const tools = args.indexOf('--tools');
    expect(args[tools + 1]).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--disable-slash-commands');
    expect(args.slice(args.indexOf('--system-prompt'))).toEqual(['--system-prompt', 'sys']);
    // The prompt is never an argument: it goes to stdin.
    expect(args.join(' ')).not.toContain(SECRET_PROMPT);
  });

  it('moves a very long system prompt to stdin', () => {
    const system = 'x'.repeat(13_000);
    expect(buildCliArgs({ model: 'haiku', system })).not.toContain('--system-prompt');
    expect(buildStdin({ system, messages: [{ role: 'user', content: 'hi' }] })).toContain(system);
  });

  it('formats a multi-turn conversation', () => {
    const text = buildStdin({
      system: '',
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(text).toBe('Human: a\n\nAssistant: b\n\nHuman: c\n\nAssistant:');
  });
});

describe('helpers', () => {
  it('checks the bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches('Bearer nope', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('parses the CLI result and counts cache tokens as input', () => {
    expect(parseCliOutput(cliJson(), 'sonnet')).toEqual({
      text: SECRET_ANSWER,
      model: 'reported-model',
      finishReason: 'stop',
      usage: { inputTokens: 17, outputTokens: 7 },
    });
    expect(parseCliOutput(cliJson({ modelUsage: undefined }), 'sonnet')?.model).toBe('sonnet');
    expect(parseCliOutput(cliJson({ is_error: true }), 'sonnet')).toBeNull();
    expect(parseCliOutput('not json', 'sonnet')).toBeNull();
  });

  it('resolves the native binary on Windows and refuses a .cmd shim', () => {
    const exists = (p) => p.endsWith('claude.cmd') || p.endsWith('claude.exe');
    const found = resolveClaudeBinary({ PATH: 'C:\\npm' }, 'win32', exists);
    expect(found).toMatch(/claude\.exe$/);
    expect(resolveClaudeBinary({}, 'linux', exists)).toBe('claude');
    expect(() =>
      resolveClaudeBinary({ CLAUDE_CLI_BIN: 'C:\\x\\claude.cmd' }, 'win32', exists),
    ).toThrow();
    expect(resolveClaudeBinary({ CLAUDE_CLI_BIN: '/opt/claude' }, 'linux', exists)).toBe(
      '/opt/claude',
    );
  });

  it('refuses to start without a token of 16+ characters', () => {
    expect(() => createBridge({ token: '' })).toThrow();
    expect(() => createBridge({ token: 'short' })).toThrow();
  });
});

describe('http bridge', () => {
  it('rejects a missing or wrong token without spawning', async () => {
    const { spawn, calls } = fakeSpawn(succeed());
    const { post } = await start({ spawn });
    expect((await post(goodBody, '')).status).toBe(401);
    expect((await post(goodBody, 'wrong-token-wrong-token')).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects bad input, including a model that looks like a flag', async () => {
    const { spawn, calls } = fakeSpawn(succeed());
    const { post } = await start({ spawn });
    expect((await post({ ...goodBody, model: '--dangerously-skip-permissions' })).status).toBe(400);
    expect((await post({ ...goodBody, messages: [] })).status).toBe(400);
    expect((await post('{not json')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('runs the CLI in an empty cwd, feeds stdin, strips API keys and returns text and usage', async () => {
    const { spawn, calls } = fakeSpawn(succeed());
    const { post } = await start({ spawn, bin: 'claude-bin' });
    const response = await post({ ...goodBody, maxOutputTokens: 500 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      backend: 'claude',
      text: SECRET_ANSWER,
      model: 'reported-model',
      finishReason: 'stop',
      usage: { inputTokens: 17, outputTokens: 7 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe('claude-bin');
    expect(calls[0].stdin).toBe(SECRET_PROMPT);
    expect(calls[0].options.cwd).toBe('/tmp/fake-cwd');
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0].options.env.CLAUDE_CLI_BRIDGE_TOKEN).toBeUndefined();
    expect(calls[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('500');
  });

  it('never logs a prompt, a response or the token', async () => {
    const { spawn } = fakeSpawn(succeed());
    const { post, logs } = await start({ spawn });
    await post(goodBody);
    await post(goodBody, 'wrong-token-wrong-token');
    const text = JSON.stringify(logs);
    expect(logs).toHaveLength(2);
    expect(text).not.toContain(SECRET_PROMPT);
    expect(text).not.toContain(SECRET_ANSWER);
    expect(text).not.toContain(TOKEN);
    expect(logs[0]).toMatchObject({ status: 200, inputTokens: 17, outputTokens: 7 });
  });

  it('times out, kills the child and answers 504', async () => {
    let killedChild;
    const { spawn } = fakeSpawn((child) => {
      killedChild = child; // never closes
    });
    const { post } = await start({ spawn, timeoutMs: 30 });
    const response = await post(goodBody);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'timeout' });
    expect(killedChild.killed).toBe(true);
  });

  it('kills the child and frees the slot when the caller closes the connection before the answer (C-7)', async () => {
    const children = [];
    const { spawn } = fakeSpawn((started) => {
      children.push(started); // never closes by itself
    });
    const { url, post, logs } = await start({ spawn, maxConcurrency: 1 });
    const controller = new AbortController();
    const abandoned = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(goodBody),
      signal: controller.signal,
    }).catch(() => 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(children[0].killed).toBe(false);
    controller.abort();
    expect(await abandoned).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(children[0].killed).toBe(true);
    expect(logs.at(-1)).toMatchObject({ status: 499, error: 'client_closed' });
    // The slot (maxConcurrency 1) is free again: the next request is not answered 429.
    const next = post(goodBody);
    await new Promise((resolve) => setTimeout(resolve, 100));
    children[1].stdout.write(cliJson());
    children[1].emit('close', 0);
    expect((await next).status).toBe(200);
  });

  it('answers 502 without echoing stderr or stdout when the CLI fails', async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stderr.write(SECRET_PROMPT);
      child.emit('close', 1);
    });
    const { post } = await start({ spawn });
    const response = await post(goodBody);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain(SECRET_PROMPT);
  });

  it('limits concurrency and answers 429 when full', async () => {
    const pending = [];
    const { spawn } = fakeSpawn((child) => {
      pending.push(child);
    });
    const { post } = await start({ spawn, maxConcurrency: 1 });
    const first = post(goodBody);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(goodBody);
    expect(second.status).toBe(429);
    pending[0].stdout.write(cliJson());
    pending[0].emit('close', 0);
    expect((await first).status).toBe(200);
  });
});

describe('online check and /healthz (ADR-019)', () => {
  it('answers /healthz without a token and reveals only status, online and a time', async () => {
    const { base } = await start({
      checkOnline: () => Promise.resolve({ online: false, at: Date.UTC(2026, 10, 3) }),
    });
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).toSorted()).toEqual(['checkedAt', 'online', 'status']);
    expect(body).toMatchObject({ status: 'ok', online: false });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('answers 503 offline without spawning the CLI when the host is offline', async () => {
    const { spawn, calls } = fakeSpawn(succeed());
    const { post } = await start({
      spawn,
      checkOnline: () => Promise.resolve({ online: false, at: Date.now() }),
    });
    const response = await post(goodBody);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'offline' });
    expect(calls).toHaveLength(0);
  });

  it('still asks for the token before it says anything about being offline', async () => {
    const { post } = await start({
      checkOnline: () => Promise.resolve({ online: false, at: Date.now() }),
    });
    expect((await post(goodBody, 'wrong-token-0123456789')).status).toBe(401);
  });

  it('caches the probe for the TTL and shares one in-flight probe', async () => {
    let now = 1_000;
    let probes = 0;
    const check = createOnlineChecker({
      probe: () => {
        probes += 1;
        return Promise.resolve(true);
      },
      ttlMs: 10_000,
      now: () => now,
    });
    await Promise.all([check(), check(), check()]);
    expect(probes).toBe(1);
    now += 9_000;
    await check();
    expect(probes).toBe(1);
    now += 2_000;
    await check();
    expect(probes).toBe(2);
  });

  it('treats a throwing probe as offline', async () => {
    const check = createOnlineChecker({ probe: () => Promise.reject(new Error('dns')) });
    expect((await check()).online).toBe(false);
  });

  it('tcpReachable is false on error and true on connect (fake socket)', async () => {
    const make = (event) => () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit(event));
      return socket;
    };
    expect(await tcpReachable('h', 1, 100, make('connect'))).toBe(true);
    expect(await tcpReachable('h', 1, 100, make('error'))).toBe(false);
    expect(await tcpReachable('h', 1, 100, make('timeout'))).toBe(false);
  });
});
