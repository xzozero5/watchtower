import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCliArgs,
  buildStdin,
  createBridge,
  createOnlineChecker,
  parseCliOutput,
  tcpReachable,
  resolveClaudeBinary,
  tokenMatches,
} from './bridge.mjs';

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
