import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * The `examples/` directory of this repository, found relative to this file (`src/seed` and
 * `dist/seed` are the same depth). A deployment whose image does not ship `examples/` passes its
 * own directory (`--examples` / `SEED_EXAMPLES_DIR`).
 */
export const DEFAULT_EXAMPLES_DIR = fileURLToPath(new URL('../../../../examples', import.meta.url));

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

/** What a Zod schema offers; typed structurally because this package does not depend on zod itself. */
export interface JsonSchema<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

/** Reads a JSON file and validates it; the error names the file and every problem, never the content. */
export async function readJsonFile<T>(file: string, schema: JsonSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new SeedError(
      `${file} cannot be read as JSON: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new SeedError(`${file} is not valid: ${problems}`);
  }
  return parsed.data;
}
