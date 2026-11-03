// Starts the bridge: `pnpm claude-bridge` (ADR-017). Dev/POC only.
import {
  createBridge,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  resolveClaudeBinary,
} from './bridge.mjs';

if (process.env.NODE_ENV === 'production') {
  console.error('claude-cli-bridge: refusing to run with NODE_ENV=production');
  process.exit(1);
}
const token = process.env.CLAUDE_CLI_BRIDGE_TOKEN ?? '';
const port = Number(process.env.CLAUDE_CLI_BRIDGE_PORT ?? DEFAULT_PORT);
// 127.0.0.1 by default. Docker Desktop reaches it through host.docker.internal; set
// CLAUDE_CLI_BRIDGE_HOST only if your setup cannot (the token is then the only protection).
// The container image (ADR-019) sets 0.0.0.0 and publishes no port: only the compose network
// reaches it, with the bearer token still required.
const host = process.env.CLAUDE_CLI_BRIDGE_HOST ?? '127.0.0.1';

let server;
try {
  server = createBridge({
    token,
    bin: resolveClaudeBinary(),
    timeoutMs: Number(process.env.CLAUDE_CLI_BRIDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    maxConcurrency: Number(
      process.env.CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY ?? DEFAULT_MAX_CONCURRENCY,
    ),
    // Metadata only: never a prompt, a response or the token.
    log: (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry })),
  });
} catch (error) {
  console.error(`claude-cli-bridge: ${error.message}`);
  process.exit(1);
}
server.listen(port, host, () => {
  console.log(
    `claude-cli-bridge listening on ${host}:${String(port)} (tools off, bodies never logged)`,
  );
});
