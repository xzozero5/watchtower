import { sha256Hex } from './hash.js';
import type { PromptRef } from './contract.js';

/**
 * Prompt files live in `packages/ai/prompts/` as `<id>.v<version>.md`. A file starts with a front
 * matter block that repeats the id and version, so a renamed file cannot silently change which
 * prompt an audit row points at:
 *
 *     ---
 *     id: classifier
 *     version: 1
 *     ---
 *     <prompt body>
 *
 * The hash covers the whole file content, so any edit, even whitespace, changes it and an eval
 * run can tell which text produced a result. A new behaviour is a new version, not an edit.
 */
export interface PromptFile {
  readonly ref: Readonly<PromptRef>;
  readonly body: string;
}

const FILE_NAME = /^([a-z][a-z0-9_.-]*)\.v([1-9]\d*)\.md$/;
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export class PromptFileError extends Error {
  override readonly name = 'PromptFileError';
}

/** Pure parser. Reading the file is the caller's job (this package does no I/O of its own). */
export function parsePromptFile(fileName: string, content: string): PromptFile {
  const named = FILE_NAME.exec(fileName);
  if (named === null) {
    throw new PromptFileError(`Prompt file name must look like <id>.v<version>.md: ${fileName}`);
  }
  const front = FRONT_MATTER.exec(content.replaceAll('\r\n', '\n'));
  if (front === null) throw new PromptFileError(`Prompt ${fileName} has no front matter`);

  const fields = new Map<string, string>();
  for (const line of (front[1] ?? '').split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0)
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const id = named[1] ?? '';
  const version = Number(named[2]);
  if (fields.get('id') !== id || Number(fields.get('version')) !== version) {
    throw new PromptFileError(`Prompt ${fileName}: front matter id/version do not match the name`);
  }
  return Object.freeze({
    ref: Object.freeze({ id, version, hash: sha256Hex(content) }),
    body: (front[2] ?? '').trim(),
  });
}

// Prompts the catalog loaded from `packages/ai/prompts/`. A literal `{ ref, body }`, a copy and a
// parse made elsewhere are not in here, so the trusted render path (redaction/redacted-text.ts)
// cannot be fed arbitrary text. Frozen objects cannot be edited after they are registered.
const CATALOG = new WeakSet<PromptFile>();

/** For `loadPromptCatalog` only. Not exported from the package entry point. */
export function registerCatalogPrompt(file: PromptFile): PromptFile {
  CATALOG.add(file);
  return file;
}

/** True only for a prompt that `loadPromptCatalog` registered. */
export function isCatalogPrompt(file: PromptFile): boolean {
  return CATALOG.has(file);
}

/** Splits a body into literal text (even indexes) and slot names (odd indexes). */
export function splitPromptSlots(body: string): string[] {
  return body.split(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/);
}

/** Fills `{{name}}` slots. Unknown slots throw, so a typo cannot reach the provider. */
export function renderPrompt(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new PromptFileError(`Missing prompt value: ${name}`);
    return value;
  });
}
