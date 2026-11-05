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
  'AI_BRIDGE_URL',
  'AI_BRIDGE_TOKEN',
  'AI_BRIDGE_ALLOW_REMOTE',
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
    const bridge = /\n {2}ai-bridge:\n([\s\S]*?)\n {2}\S/.exec(compose)?.[1] ?? '';
    expect(bridge).toContain('read_only: true');
    expect(bridge).not.toMatch(/^ {4}ports:/m);
    expect(bridge).toContain('aliases: [claude-bridge]');
    expect(bridge).toContain('AI_BRIDGE_MODE: ${AI_BRIDGE_MODE:-codex}');
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

  it.each(['EMBEDDING_PROVIDER', 'EMBEDDING_LOCAL_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSIONS'])(
    '%s is documented in .env.example and passed through by compose (ADR-030)',
    (name) => {
      expect(envExample).toMatch(new RegExp(`^${name}=`, 'm'));
      expect(compose).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-`, 'm'));
    },
  );

  it.each(['EMBEDDING_LOCAL_HOSTS', 'EMBEDDING_DAILY_TOKEN_CAP'])(
    '%s is documented in .env.example and passed through by compose (T-435)',
    (name) => {
      expect(envExample).toMatch(new RegExp(`^${name}=$`, 'm'));
      expect(compose).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}`, 'm'));
    },
  );

  describe('the embedder has no way out and a small reach (ADR-030, T-435 C-2, C-6)', () => {
    const service = (name: string) =>
      new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)\\n {2}\\S`).exec(compose)?.[1] ?? '';
    const serviceNames = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => service(name).includes('image:') || service(name).includes('build:'));
    /** The networks a service lists (compose with no list means only `default`). */
    const networksOf = (name: string): string[] => {
      // The bridge uses an explicit network alias to preserve the legacy hostname.
      if (/\n {4}networks:\n {6}ai:\n/.test(service(name))) return ['ai'];
      const block = /\n {4}networks:\n((?: {6}- .+\n)+)/.exec(`${service(name)}\n`)?.[1];
      return block === undefined
        ? ['default']
        : [...block.matchAll(/- (\S+)/g)].map((match) => match[1] ?? '');
    };
    const members = (network: string) =>
      serviceNames.filter((name) => networksOf(name).includes(network)).sort();
    const networkBlock = (name: string) =>
      new RegExp(`\\n {2}${name}:([^\\n]*)\\n((?: {4}.+\\n)*)`).exec(
        compose.slice(compose.indexOf('\nnetworks:')),
      );

    it('sees every service (the helpers work)', () => {
      expect(serviceNames).toEqual(expect.arrayContaining(['api', 'worker', 'embedder']));
    });

    it('the embedder is on `embed` only: no default, no ai, no port', () => {
      const embedder = service('embedder');
      expect(embedder).toMatch(/profiles: \['ai'\]/);
      expect(networksOf('embedder')).toEqual(['embed']);
      expect(embedder).not.toMatch(/^ {4}ports:/m);
      expect(embedder).toMatch(/embeddermodels:\/data/);
      expect(embedder).toMatch(/mem_limit:/);
      expect(embedder).toMatch(/healthcheck:/);
    });

    it('`embed` is internal and is shared by the embedder, the api and the worker only', () => {
      expect(networkBlock('embed')?.[2]).toMatch(/internal: true/);
      expect(members('embed')).toEqual(['api', 'embedder', 'worker']);
    });

    it('claude-bridge (and every other service) cannot reach the embedder admin API', () => {
      expect(networksOf('ai-bridge')).toEqual(['ai']);
      expect(members('ai')).not.toContain('embedder');
      for (const name of serviceNames.filter((n) => !['api', 'worker', 'embedder'].includes(n))) {
        expect(networksOf(name), name).not.toContain('embed');
      }
    });

    it('the runtime embedder never downloads: no pull in it, and nothing points a pull at it', () => {
      const embedder = service('embedder');
      expect(embedder).not.toMatch(/ollama pull/);
      expect(embedder).not.toMatch(/entrypoint:|command:/);
      expect(compose).not.toMatch(/OLLAMA_HOST: http:\/\/embedder/);
    });

    it('embedder-init downloads with its own server on `embed-egress`, which only it joins', () => {
      const init = service('embedder-init');
      expect(init).toMatch(/profiles: \['ai'\]/);
      expect(init).toMatch(/restart: 'no'/);
      expect(networksOf('embedder-init')).toEqual(['embed-egress']);
      expect(members('embed-egress')).toEqual(['embedder-init']);
      expect(networkBlock('embed-egress')?.[2] ?? '').not.toMatch(/internal: true/);
      expect(init).toMatch(/ollama serve/);
      expect(init).toMatch(/OLLAMA_HOST: 127\.0\.0\.1:11434/);
      expect(init).toMatch(/ollama pull "\$\$EMBEDDING_MODEL"/);
      expect(init).not.toMatch(/depends_on:/);
      expect(init).toMatch(/embeddermodels:\/data/);
      expect(compose).toMatch(/^ {2}embeddermodels:/m);
    });

    it('both are pinned by tag and digest, to the same image, with no env override (C-6)', () => {
      const image = /image: (ollama\/ollama:[0-9.]+@sha256:[0-9a-f]{64})\n/;
      const one = image.exec(service('embedder'))?.[1];
      expect(one).toBeDefined();
      expect(image.exec(service('embedder-init'))?.[1]).toBe(one);
      expect(compose).not.toMatch(/EMBEDDER_IMAGE/);
    });

    it('is hardened: non-root read-only runtime, limits and dropped capabilities on both (C-6)', () => {
      const embedder = service('embedder');
      expect(embedder).toMatch(/user: '1000:1000'/);
      expect(embedder).toMatch(/read_only: true/);
      expect(embedder).toMatch(/tmpfs:\n {6}- \/tmp/);
      const init = service('embedder-init');
      expect(init).toMatch(/mem_limit:/);
      expect(init).toMatch(/pids_limit:/);
      expect(init).toMatch(/read_only: true/);
      for (const text of [embedder, init]) {
        expect(text).toMatch(/cap_drop:\n {6}- ALL/);
        expect(text).toMatch(/no-new-privileges:true/);
        expect(text).toMatch(/pids_limit:/);
      }
      // The only capability put back is CHOWN, for the volume ownership of the one-shot.
      expect(init).toMatch(/cap_add:\n {6}- CHOWN\n(?! {6}- )/);
      expect(embedder).not.toMatch(/cap_add:/);
    });

    it('the default URL names the compose service, and the provider stays on mock', () => {
      expect(envExample).toMatch(/^EMBEDDING_LOCAL_URL=http:\/\/embedder:11434$/m);
      expect(envExample).toMatch(/^EMBEDDING_PROVIDER=mock$/m);
    });
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
