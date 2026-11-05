// Starts the vendor-neutral subscription bridge (ADR-031). No response bodies are logged.
import { pathToFileURL } from 'node:url';
import {
  createBridge,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  resolveClaudeBinary,
  resolveCodexBinary,
  assertCodexVersion,
} from './bridge.mjs';

export function readBridgeConfig(env = process.env, { legacy = false } = {}) {
  const nonEmpty = (value) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value;
  const read = (key, old, fallback) => nonEmpty(env[key]) ?? nonEmpty(env[old]) ?? fallback;
  const mode = legacy ? 'claude' : (nonEmpty(env.AI_BRIDGE_MODE) ?? 'codex');
  if (!['codex', 'claude'].includes(mode))
    throw new Error('AI_BRIDGE_MODE must be codex or claude');
  const allowRemote =
    String(read('AI_BRIDGE_ALLOW_REMOTE', 'CLAUDE_CLI_ALLOW_REMOTE', 'false'))
      .trim()
      .toLowerCase() === 'true';
  if (env.NODE_ENV === 'production' && !allowRemote)
    throw new Error('production requires AI_BRIDGE_ALLOW_REMOTE=true (ADR-021, ADR-031)');
  const positive = (value, name) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error(`${name} must be a positive integer`);
    return number;
  };
  const port = positive(
    read('AI_BRIDGE_PORT', 'CLAUDE_CLI_BRIDGE_PORT', DEFAULT_PORT),
    'AI_BRIDGE_PORT',
  );
  if (port > 65535) throw new Error('AI_BRIDGE_PORT must be at most 65535');
  return {
    mode,
    allowRemote,
    port,
    token: read('AI_BRIDGE_TOKEN', 'CLAUDE_CLI_BRIDGE_TOKEN', ''),
    host: read('AI_BRIDGE_HOST', 'CLAUDE_CLI_BRIDGE_HOST', '127.0.0.1'),
    timeoutMs: positive(
      read('AI_BRIDGE_TIMEOUT_MS', 'CLAUDE_CLI_BRIDGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      'AI_BRIDGE_TIMEOUT_MS',
    ),
    maxConcurrency: positive(
      read(
        'AI_BRIDGE_MAX_CONCURRENCY',
        'CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY',
        DEFAULT_MAX_CONCURRENCY,
      ),
      'AI_BRIDGE_MAX_CONCURRENCY',
    ),
  };
}

export function startBridge({ legacy = false, env = process.env } = {}) {
  let config;
  let server;
  try {
    config = readBridgeConfig(env, { legacy });
    const bin = config.mode === 'codex' ? resolveCodexBinary(env) : resolveClaudeBinary(env);
    if (config.mode === 'codex') assertCodexVersion(bin, env);
    server = createBridge({
      ...config,
      env,
      bin,
      log: (entry) =>
        console.log(
          JSON.stringify({ at: new Date().toISOString(), backend: config.mode, ...entry }),
        ),
    });
  } catch {
    console.error(
      'ai-bridge: startup failed; check bridge mode, isolation, token and runtime configuration',
    );
    process.exitCode = 1;
    return;
  }
  server.on('error', () => {
    console.error('ai-bridge: listener failed');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.log(`ai-bridge listening (${config.mode}, bodies never logged)`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startBridge();
