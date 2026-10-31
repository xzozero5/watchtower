import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_INTENT_EXAMPLES_DIR,
  IntentSeedError,
  loadIntentDefinitions,
  upsertIntentDefinitions,
} from './intents.js';

// The starter taxonomy of PRD section 3.1.
const PRD_KEYS = [
  'account_access',
  'api_error',
  'billing_report',
  'feature_question',
  'incident_inquiry',
  'other',
  'processing_failure',
  'result_dispute',
  'upstream_timeout',
  'webhook_not_received',
  'workspace_config',
];

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wt-intents-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const valid = {
  key: 'probe_intent',
  name: 'Probe',
  description: 'd',
  typicalEvidence: 'e',
  defaultPriority: 'P3',
};

async function loadFrom(files: Record<string, string>) {
  const target = await mkdtemp(join(dir, 'case-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(target, name), content);
  }
  return loadIntentDefinitions(target);
}

describe('examples/intents', () => {
  it('holds exactly the PRD section 3.1 taxonomy, valid and with Thai and English templates', async () => {
    const definitions = await loadIntentDefinitions(DEFAULT_INTENT_EXAMPLES_DIR);
    expect(definitions.map((definition) => definition.key).toSorted()).toEqual(PRD_KEYS);
    for (const definition of definitions) {
      expect(definition.replyTemplates.map((template) => template.key)).toEqual([
        'ack_en',
        'ack_th',
      ]);
    }
    expect(definitions.find((definition) => definition.key === 'other')?.defaultPriority).toBe(
      'P3',
    );
  });

  it('names no business domain of a particular deployment (the repository is public and neutral)', async () => {
    const definitions = await loadIntentDefinitions(DEFAULT_INTENT_EXAMPLES_DIR);
    const text = JSON.stringify(definitions).toLowerCase();
    for (const forbidden of ['.co.th', 'liveness', 'ekyc']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('loadIntentDefinitions', () => {
  it('ignores files that are not JSON', async () => {
    const loaded = await loadFrom({
      'a.json': JSON.stringify(valid),
      'README.md': '# not an intent',
    });
    expect(loaded.map((definition) => definition.key)).toEqual(['probe_intent']);
  });

  it('drops an autonomy stage written in a file: every intent starts at stage 2 (N3)', async () => {
    const [definition] = await loadFrom({
      'a.json': JSON.stringify({ ...valid, autonomyStage: 4 }),
    });
    expect(definition).toBeDefined();
    expect(definition !== undefined && 'autonomyStage' in definition).toBe(false);
  });

  it('names the file when JSON is broken', async () => {
    await expect(loadFrom({ 'broken.json': '{ nope' })).rejects.toThrow(
      /broken\.json is not valid JSON/,
    );
  });

  it('names the file and the field when an intent is invalid', async () => {
    await expect(
      loadFrom({ 'bad.json': JSON.stringify({ ...valid, defaultPriority: 'P9' }) }),
    ).rejects.toThrow(/bad\.json is not a valid intent: defaultPriority/);
    await expect(
      loadFrom({ 'bad.json': JSON.stringify({ ...valid, key: 'Not Snake' }) }),
    ).rejects.toThrow(IntentSeedError);
  });

  it('refuses the same key in two files', async () => {
    await expect(
      loadFrom({ 'a.json': JSON.stringify(valid), 'b.json': JSON.stringify(valid) }),
    ).rejects.toThrow(/repeats the intent key "probe_intent"/);
  });
});

describe('upsertIntentDefinitions', () => {
  it('does nothing for an empty list without touching the database', async () => {
    const executor = {
      insert: () => {
        throw new Error('must not insert');
      },
    };
    await expect(upsertIntentDefinitions(executor, [])).resolves.toEqual({
      inserted: [],
      existing: [],
    });
  });
});
