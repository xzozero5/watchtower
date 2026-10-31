import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { intentDefinitionSchema, type IntentDefinition } from '@watchtower/shared';

import type { Database } from '../client.js';
import { intent } from '../schema/ticketing.js';

/**
 * Loads the starter intents (PRD section 3.1) from `examples/intents/*.json` into the `intent`
 * table. The seed script (T-008) calls `seedIntents`; nothing in the application hard-codes a key.
 *
 * Existing rows are left alone (`ON CONFLICT DO NOTHING`), so an intent edited in a running
 * instance keeps its edits when the seed runs again. New rows get the column defaults, which means
 * autonomy stage 2, draft-for-approval (N3): the definition files cannot say otherwise.
 */

/** `examples/intents` of this repository, found relative to this file. A deployment passes its own directory. */
export const DEFAULT_INTENT_EXAMPLES_DIR = fileURLToPath(
  new URL('../../../../examples/intents', import.meta.url),
);

export class IntentSeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentSeedError';
  }
}

/** Reads and validates every `*.json` file of a directory, in file-name order. */
export async function loadIntentDefinitions(
  dir: string = DEFAULT_INTENT_EXAMPLES_DIR,
): Promise<IntentDefinition[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).toSorted();
  const definitions: IntentDefinition[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, file), 'utf8'));
    } catch (error) {
      throw new IntentSeedError(
        `${file} is not valid JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    const parsed = intentDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new IntentSeedError(`${file} is not a valid intent: ${problems}`);
    }
    if (seen.has(parsed.data.key)) {
      throw new IntentSeedError(`${file} repeats the intent key "${parsed.data.key}"`);
    }
    seen.add(parsed.data.key);
    definitions.push(parsed.data);
  }
  return definitions;
}

export interface IntentSeedResult {
  readonly inserted: readonly string[];
  readonly existing: readonly string[];
}

/** Inserts the definitions that are not in the table yet. Accepts the database or a transaction. */
export async function upsertIntentDefinitions(
  executor: Pick<Database['db'], 'insert'>,
  definitions: readonly IntentDefinition[],
): Promise<IntentSeedResult> {
  if (definitions.length === 0) return { inserted: [], existing: [] };
  const rows = await executor
    .insert(intent)
    .values(
      definitions.map((definition) => ({
        key: definition.key,
        name: definition.name,
        description: definition.description,
        typicalEvidence: definition.typicalEvidence,
        defaultPriority: definition.defaultPriority,
        allowedTools: [...definition.allowedTools],
        replyTemplates: definition.replyTemplates,
      })),
    )
    .onConflictDoNothing({ target: intent.key })
    .returning({ key: intent.key });
  const inserted = new Set(rows.map((row) => row.key));
  return {
    inserted: definitions.map((definition) => definition.key).filter((key) => inserted.has(key)),
    existing: definitions.map((definition) => definition.key).filter((key) => !inserted.has(key)),
  };
}

export async function seedIntents(
  executor: Pick<Database['db'], 'insert'>,
  dir: string = DEFAULT_INTENT_EXAMPLES_DIR,
): Promise<IntentSeedResult> {
  return upsertIntentDefinitions(executor, await loadIntentDefinitions(dir));
}
