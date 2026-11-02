import { ConnectorQueryRejectedError } from '../common/errors.js';
import { checkParams, hasStrayBraces, placeholdersOf } from '../common/template.js';
import { LOG_SEVERITIES, type LogEntry, type LogSeverity } from './types.js';

/**
 * The part of the Cloud Logging query language the saved templates and the fake understand: terms
 * joined by `AND` (or by spaces), each one of
 *
 *   service="name"                     (also resource.labels.service_name)
 *   labels.key="value"                 (also jsonPayload.key, which logs of this product use as labels)
 *   severity>=ERROR
 *   "some text"                        the message contains the text, any case
 *
 * Anything else is refused, so the fake never pretends to match what it cannot read. A live adapter
 * passes the filter to the provider as it is.
 */

export type LogTerm =
  | { readonly kind: 'service'; readonly value: string }
  | { readonly kind: 'label'; readonly key: string; readonly value: string }
  | { readonly kind: 'severity'; readonly atLeast: LogSeverity }
  | { readonly kind: 'text'; readonly value: string };

export const MAX_FILTER_CHARS = 2000;

/** A string literal for a filter: quoted, with `\` and `"` escaped. Values are checked first by `checkParams`. */
export function quoteLogLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Fills a template's `{{name}}` placeholders with quoted literals. Throws `ConnectorQueryRejectedError`
 * when a parameter is missing, is not declared, or holds a character a plain value cannot.
 */
export function renderLogFilter(template: string, params: Readonly<Record<string, string>>): string {
  if (hasStrayBraces(template)) {
    throw new ConnectorQueryRejectedError('The template has a malformed placeholder');
  }
  checkParams(placeholdersOf(template), params);
  const filled = template.replaceAll(/\{\{([a-z][a-z0-9_]{0,30})\}\}/g, (_all, name: string) =>
    quoteLogLiteral(params[name] ?? ''),
  );
  if (filled.length > MAX_FILTER_CHARS) {
    throw new ConnectorQueryRejectedError('The filter is too long');
  }
  return filled;
}

interface Token {
  readonly text: string;
  readonly quoted: boolean;
}

function tokenize(filter: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < filter.length) {
    const char = filter[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      let closed = false;
      while (index < filter.length) {
        const next = filter[index] ?? '';
        if (next === '\\') {
          value += filter[index + 1] ?? '';
          index += 2;
          continue;
        }
        index += 1;
        if (next === '"') {
          closed = true;
          break;
        }
        value += next;
      }
      if (!closed) throw new ConnectorQueryRejectedError('Unterminated string in the filter');
      tokens.push({ text: value, quoted: true });
      continue;
    }
    // A bare word runs to the next space, but a quoted value after `=` stays in the same term.
    let word = '';
    while (index < filter.length && !/\s/.test(filter[index] ?? '')) {
      if (filter[index] === '"') {
        // key="value": read the quoted part into the word, keeping quotes out.
        index += 1;
        let closed = false;
        while (index < filter.length) {
          const next = filter[index] ?? '';
          if (next === '\\') {
            word += filter[index + 1] ?? '';
            index += 2;
            continue;
          }
          index += 1;
          if (next === '"') {
            closed = true;
            break;
          }
          word += next;
        }
        if (!closed) throw new ConnectorQueryRejectedError('Unterminated string in the filter');
        continue;
      }
      word += filter[index] ?? '';
      index += 1;
    }
    tokens.push({ text: word, quoted: false });
  }
  return tokens;
}

const isSeverity = (value: string): value is LogSeverity =>
  (LOG_SEVERITIES as readonly string[]).includes(value);

/** Parses a filter into terms. An empty filter is allowed (every entry of the range). */
export function parseLogFilter(filter: string): LogTerm[] {
  if (filter.length > MAX_FILTER_CHARS) {
    throw new ConnectorQueryRejectedError('The filter is too long');
  }
  const terms: LogTerm[] = [];
  for (const token of tokenize(filter)) {
    if (token.quoted) {
      terms.push({ kind: 'text', value: token.text });
      continue;
    }
    if (token.text === 'AND') continue;
    const severity = /^severity>=([A-Z]+)$/.exec(token.text);
    if (severity !== null) {
      const level = severity[1] ?? '';
      if (!isSeverity(level)) throw new ConnectorQueryRejectedError('Unknown severity in the filter');
      terms.push({ kind: 'severity', atLeast: level });
      continue;
    }
    const equals = /^([A-Za-z_][A-Za-z0-9_.]*)=(.*)$/s.exec(token.text);
    if (equals === null) throw new ConnectorQueryRejectedError('The filter holds a term the client does not read');
    const field = equals[1] ?? '';
    const value = equals[2] ?? '';
    if (field === 'service' || field === 'resource.labels.service_name') {
      terms.push({ kind: 'service', value });
    } else if (field.startsWith('labels.') && field.length > 7) {
      terms.push({ kind: 'label', key: field.slice(7), value });
    } else if (field.startsWith('jsonPayload.') && field.length > 12) {
      terms.push({ kind: 'label', key: field.slice(12), value });
    } else {
      throw new ConnectorQueryRejectedError('The filter names a field the client does not read');
    }
  }
  return terms;
}

const rank = (severity: LogSeverity): number => LOG_SEVERITIES.indexOf(severity);

export function matchesLogFilter(entry: LogEntry, terms: readonly LogTerm[]): boolean {
  return terms.every((term) => {
    switch (term.kind) {
      case 'service':
        return entry.service === term.value;
      case 'label':
        return entry.labels[term.key] === term.value;
      case 'severity':
        return rank(entry.severity) >= rank(term.atLeast);
      case 'text':
        return entry.message.toLowerCase().includes(term.value.toLowerCase());
    }
  });
}
