import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parsePromptFile,
  PromptFileError,
  registerCatalogPrompt,
  type PromptFile,
} from './prompts.js';

/**
 * `packages/ai/prompts/`, found from this file: `src/` and `dist/` are both one level below the
 * package root. `package.json` lists `prompts` in `files`, so a deployed copy carries it.
 */
export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));

export interface PromptCatalog {
  /** The highest version of the prompt. Throws when the prompt does not exist. */
  latest(id: string): PromptFile;
  /** One exact version, for replaying an old `ai_run`. */
  version(id: string, version: number): PromptFile;
  /** Every `id@version` loaded, for tests and the admin view. */
  list(): readonly { id: string; version: number; hash: string }[];
}

/**
 * Reads every `<id>.v<version>.md` file of a directory once. A file that does not parse is an
 * error at start, not at the first call: a broken prompt must stop the deploy, not an agent run.
 */
export function loadPromptCatalog(dir: string = DEFAULT_PROMPTS_DIR): PromptCatalog {
  const files = new Map<string, PromptFile>();
  for (const name of readdirSync(dir).toSorted()) {
    if (!/\.v[0-9]+\.md$/.test(name)) continue;
    const parsed = registerCatalogPrompt(
      parsePromptFile(name, readFileSync(join(dir, name), 'utf8')),
    );
    files.set(`${parsed.ref.id}@${String(parsed.ref.version)}`, parsed);
  }
  const all = [...files.values()];
  return {
    latest(id) {
      const versions = all.filter((file) => file.ref.id === id);
      const best = versions.reduce<PromptFile | undefined>(
        (top, file) => (top === undefined || file.ref.version > top.ref.version ? file : top),
        undefined,
      );
      if (best === undefined) throw new PromptFileError(`No prompt named ${id}`);
      return best;
    },
    version(id, version) {
      const found = files.get(`${id}@${String(version)}`);
      if (found === undefined)
        throw new PromptFileError(`No prompt ${id} version ${String(version)}`);
      return found;
    },
    list() {
      return all.map((file) => ({
        id: file.ref.id,
        version: file.ref.version,
        hash: file.ref.hash,
      }));
    },
  };
}
