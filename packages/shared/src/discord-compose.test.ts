import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { INTEGRATION_CATALOG } from './features/credentials.js';
import { DISCORD_SLOT_CREDENTIAL_FIELDS, DISCORD_WEBHOOK_SLOTS } from './features/discord.js';

// The compose file lists the environment of the containers one by one. A variable that is in
// `.env.example` but not in that list never reaches the process, and the Discord notifier then
// stays in mock mode on a deployment that did everything the example says (security review F-1).
const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
const envExample = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');

describe('Discord settings reach the containers (F-1)', () => {
  const variables = [
    ...DISCORD_WEBHOOK_SLOTS.map(
      (slot) => INTEGRATION_CATALOG.discord.fields[DISCORD_SLOT_CREDENTIAL_FIELDS[slot]].env,
    ),
    'DISCORD_CHANNEL_MAP',
  ];

  it.each(variables)('%s is documented in .env.example and passed through by compose', (name) => {
    expect(envExample).toMatch(new RegExp(`^${name}=`, 'm'));
    expect(compose).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}:-\\}`, 'm'));
  });
});
