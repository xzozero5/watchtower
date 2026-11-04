import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The compose file lists the environment of the containers one by one. An AI variable that is in
// `.env.example` but not in that list never reaches the worker: the provider stays on its default
// and the daily caps are not applied (T-132).
const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

const AI_VARIABLES = [
  'AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CLI_BRIDGE_URL',
  'CLAUDE_CLI_BRIDGE_TOKEN',
  'CLAUDE_CLI_ALLOW_REMOTE',
  'VERTEX_PROJECT_ID',
  'VERTEX_LOCATION',
  'AI_MODEL_DEEP',
  'AI_MODEL_STANDARD',
  'AI_MODEL_LIGHT',
  'AI_MODEL_PRICES',
  'AI_DAILY_COST_CAP_USD',
  'AI_DAILY_TOKEN_CAP',
  'AI_BUDGET_ALERT_PERCENT',
];

describe('AI settings reach the containers (T-132)', () => {
  it.each(AI_VARIABLES)(
    '%s is documented in .env.example and passed through by compose',
    (name) => {
      expect(envExample).toMatch(new RegExp(`^${name}=`, 'm'));
      expect(compose).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-`, 'm'));
    },
  );

  it('the worker reaches claude-bridge on the compose network and the bridge publishes no port (ADR-021)', () => {
    expect(compose).toMatch(
      /CLAUDE_CLI_BRIDGE_URL: \$\{CLAUDE_CLI_BRIDGE_URL:-http:\/\/claude-bridge:4317\}/,
    );
    expect(envExample).toMatch(/^CLAUDE_CLI_BRIDGE_URL=http:\/\/claude-bridge:4317$/m);
    expect(compose).not.toMatch(/CLAUDE_CLI_BRIDGE_PORT/);
    const bridge = /\n {2}claude-bridge:\n([\s\S]*?)\n {2}\S/.exec(compose)?.[1] ?? '';
    expect(bridge).toContain('read_only: true');
    expect(bridge).not.toMatch(/^ {4}ports:/m);
    expect(envExample).toMatch(/^CLAUDE_CLI_ALLOW_REMOTE=false$/m);
  });

  it('the api and the worker are the only members of the ai network, and the api cap is below the bridge slots (ADR-023)', () => {
    const service = (name: string) =>
      new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n {2}\\S`).exec(compose)?.[1] ?? '';
    expect(service('api')).toMatch(/networks:[\s\S]*- ai\b/);
    expect(service('worker')).toMatch(/networks:[\s\S]*- ai\b/);
    for (const name of ['web', 'caddy', 'minio']) {
      expect(service(name)).not.toMatch(/- ai\b/);
    }
    expect(compose).toMatch(/AI_API_MAX_CONCURRENCY: \$\{AI_API_MAX_CONCURRENCY:-2\}/);
    expect(compose).toMatch(/CLAUDE_CLI_BRIDGE_MAX_CONCURRENCY:-4\}/);
    expect(envExample).toMatch(/^AI_API_MAX_CONCURRENCY=2$/m);
  });

  it('.env.example keeps the provider on mock and holds no model name', () => {
    expect(envExample).toMatch(/^AI_PROVIDER=mock$/m);
    for (const name of [
      'AI_MODEL_DEEP',
      'AI_MODEL_STANDARD',
      'AI_MODEL_LIGHT',
      'AI_MODEL_PRICES',
    ]) {
      expect(envExample).toMatch(new RegExp(`^${name}=$`, 'm'));
    }
  });
});
