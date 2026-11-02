import { ConnectorQueryRejectedError } from './errors.js';

/**
 * Saved templates (R-5.1, R-5.2) name their parameters as `{{name}}`. A value never becomes part of
 * the query text on its own: a log filter gets it as a quoted literal that cannot be closed from the
 * inside, and a SQL statement gets it as a bind parameter. The value is also limited to a short,
 * plain alphabet (ids, slugs, e-mail-like keys), which is all a template parameter needs.
 */

export const PARAM_NAME_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
/** Characters a parameter value may hold. No quote, backslash, space, control character or wildcard. */
export const PARAM_VALUE_PATTERN = /^[A-Za-z0-9._:@+/-]{1,128}$/;
export const MAX_TEMPLATE_PLACEHOLDERS = 12;

const PLACEHOLDER = /\{\{([a-z][a-z0-9_]{0,30})\}\}/g;

/** The distinct placeholder names of `text`, in order of first use. */
export function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** True when `text` still holds a `{{` that is not a well-formed placeholder (a typo that would leak into the query). */
export function hasStrayBraces(text: string): boolean {
  return (
    text.replaceAll(PLACEHOLDER, '').includes('{{') ||
    text.replaceAll(PLACEHOLDER, '').includes('}}')
  );
}

/** Throws when `values` does not name exactly the placeholders of `names`, or a value is outside the alphabet. */
export function checkParams(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): void {
  if (names.length > MAX_TEMPLATE_PLACEHOLDERS) {
    throw new ConnectorQueryRejectedError('The template has too many parameters');
  }
  for (const name of names) {
    const value = values[name];
    if (value === undefined) throw new ConnectorQueryRejectedError(`Missing parameter: ${name}`);
    if (!PARAM_VALUE_PATTERN.test(value)) {
      throw new ConnectorQueryRejectedError(
        `Parameter ${name} holds a character that is not allowed`,
      );
    }
  }
  for (const key of Object.keys(values)) {
    if (!names.includes(key)) throw new ConnectorQueryRejectedError(`Unknown parameter: ${key}`);
  }
}
