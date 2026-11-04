import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { evalFileSchema, type EvalSource, type LoadedCase } from './case.js';

export class EvalLoadError extends Error {
  override readonly name = 'EvalLoadError';
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...jsonFiles(path));
    else if (name.endsWith('.json')) found.push(path);
  }
  return found;
}

export interface CaseDir {
  readonly dir: string;
  readonly source: EvalSource;
}

/**
 * Reads every `*.json` case under the given directories. A file that does not match the schema is an
 * error naming the file (never a silent skip: a case that did not load would read as "passing"), and
 * so is an id used twice.
 */
export function loadCases(dirs: readonly CaseDir[], root: string = process.cwd()): LoadedCase[] {
  const loaded: LoadedCase[] = [];
  const seen = new Map<string, string>();
  for (const { dir, source } of dirs) {
    for (const file of jsonFiles(dir)) {
      const shown = relative(root, file);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw new EvalLoadError(`${shown}: not valid JSON`);
      }
      const parsed = evalFileSchema.safeParse(raw);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new EvalLoadError(
          `${shown}: ${first?.path.join('.') ?? ''} ${first?.message ?? 'is not an eval case'}`.trim(),
        );
      }
      for (const item of parsed.data) {
        const earlier = seen.get(item.id);
        if (earlier !== undefined) {
          throw new EvalLoadError(`${shown}: case id "${item.id}" is also in ${earlier}`);
        }
        seen.set(item.id, shown);
        loaded.push({ case: item, source, file: shown });
      }
    }
  }
  return loaded;
}
