import {
  createNameDetector,
  detectBankAccounts,
  detectCardNumbers,
  detectEmails,
  detectLiteralTokens,
  detectPhoneNumbers,
  detectThaiNationalIds,
  resolveOverlaps,
  TOKEN_PATTERN,
  type RedactionKind,
  type Span,
} from './detectors.js';
import { mintRedacted, type RedactedText } from './redacted-text.js';
import { toAsciiDigits } from './validators.js';

/** Counts of what a session replaced. Holds no original values, so it is safe to audit-log. */
export interface RedactionReport {
  total: number;
  byKind: Partial<Record<RedactionKind, number>>;
}

export interface RedactionSession {
  /**
   * Replaces PII with placeholder tokens. The same value gets the same token within a session.
   * Token-shaped text in the input (for example a literal "[EMAIL_1]") is escaped to its own
   * token, so `restore(redact(x)) === x` holds for every string.
   */
  redact(text: string): RedactedText;
  /** Puts originals back. For human-visible views only; never send the result to a provider. */
  restore(text: string): string;
  /**
   * token -> original value. This is the reversible mapping: keep it server-side (for example
   * encrypted next to the ticket), never put it in a prompt, a log or an `ai_run` row.
   */
  mapping(): Readonly<Record<string, string>>;
  report(): RedactionReport;
}

export interface Redactor {
  /** One session per prompt (or per ticket when drafts must restore later). */
  session(initialMapping?: Readonly<Record<string, string>>): RedactionSession;
}

export interface RedactorOptions {
  /**
   * Names the system already knows (contacts, organisation members). Evaluated each time a
   * session starts, so new contacts are picked up without rebuilding the redactor.
   */
  names?: () => Iterable<string>;
  /** Ignore names shorter than this many characters. Default 3. */
  minNameLength?: number;
  /** Also redact each part of a multi-word name. Default true. */
  matchNameParts?: boolean;
}

const TOKEN_INDEX = /_(\d+)\]$/;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const minNameLength = options.minNameLength ?? 3;
  const matchParts = options.matchNameParts ?? true;

  return {
    session(initialMapping = {}) {
      const nameDetector = createNameDetector({
        names: options.names?.() ?? [],
        minLength: minNameLength,
        matchParts,
      });
      const tokenToValue = new Map<string, string>(Object.entries(initialMapping));
      const valueToToken = new Map<string, string>();
      const counters = new Map<RedactionKind, number>();
      const byKind: Partial<Record<RedactionKind, number>> = {};
      let total = 0;

      for (const token of tokenToValue.keys()) {
        const kind = token.slice(1, token.lastIndexOf('_')) as RedactionKind;
        const index = Number(TOKEN_INDEX.exec(token)?.[1] ?? 0);
        counters.set(kind, Math.max(counters.get(kind) ?? 0, index));
        valueToToken.set(`${kind}\u0000${tokenToValue.get(token) ?? ''}`, token);
      }

      const tokenFor = (kind: RedactionKind, value: string): string => {
        const key = `${kind}\u0000${value}`;
        const existing = valueToToken.get(key);
        if (existing !== undefined) return existing;
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        const token = `[${kind}_${String(next)}]`;
        tokenToValue.set(token, value);
        valueToToken.set(key, token);
        return token;
      };

      return {
        redact(text) {
          const scan = toAsciiDigits(text);
          const spans: Span[] = [
            ...detectLiteralTokens(text),
            ...detectThaiNationalIds(scan),
            ...detectCardNumbers(scan),
            ...detectEmails(scan),
            ...detectBankAccounts(scan),
            ...detectPhoneNumbers(scan),
            ...nameDetector(text),
          ];
          let output = '';
          let cursor = 0;
          for (const span of resolveOverlaps(spans)) {
            output += text.slice(cursor, span.start);
            output += tokenFor(span.kind, text.slice(span.start, span.end));
            cursor = span.end;
            total += 1;
            byKind[span.kind] = (byKind[span.kind] ?? 0) + 1;
          }
          output += text.slice(cursor);
          return mintRedacted(output);
        },
        restore(text) {
          return text.replace(TOKEN_PATTERN, (token) => tokenToValue.get(token) ?? token);
        },
        mapping() {
          return Object.fromEntries(tokenToValue);
        },
        report() {
          return { total, byKind: { ...byKind } };
        },
      };
    },
  };
}
