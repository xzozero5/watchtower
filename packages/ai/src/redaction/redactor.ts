import {
  createNameDetector,
  detectEmails,
  detectNumbers,
  detectTokenShapes,
  resolveOverlaps,
  TOKEN_PATTERN,
  type RedactionKind,
  type Span,
} from './detectors.js';
import { buildView } from './normalize.js';
import { mintRedacted, type RedactedText } from './redacted-text.js';

/** Counts of what a session replaced. Holds no original values, so it is safe to audit-log. */
export interface RedactionReport {
  total: number;
  byKind: Partial<Record<RedactionKind, number>>;
}

/**
 * Where the text behind a token came from (R-2). Only `ticket` tokens, text the ticket's own
 * participants wrote, are ever restored into customer-facing output. A `tool` token comes from a
 * tool result (another ticket, a KB article, a log line) and a `model` token from text the model
 * produced; prompt injection can make the model print any token, so those are never auto-restored.
 */
export type TokenOrigin = 'ticket' | 'tool' | 'model';

export interface TokenEntry {
  value: string;
  origin: TokenOrigin;
  /** Tool name for `tool` tokens. */
  source?: string;
}

/**
 * The reversible mapping, with provenance. Keep it server-side (encrypted, next to the ticket);
 * never put it in a prompt, a log or an `ai_run` row.
 */
export interface RedactionSnapshot {
  scope: string;
  tokens: Readonly<Record<string, TokenEntry>>;
}

export type RestoreAudience =
  /** Text a customer will see: restores `ticket` tokens only. The default. */
  | 'customer'
  /** Text only staff see (evidence panels, internal notes): restores every known token. */
  | 'internal'
  /**
   * Staff-only evidence and findings: restores `ticket` tokens plus `NAME` tokens from tool output
   * (a name from the dictionary, so staff see "Acme Org" instead of "[NAME_3] Org"). Other `tool`
   * tokens (emails, phones, ids from somebody else's ticket) and `model` tokens stay placeholders.
   * Never use it for text a customer can see: the dictionary covers the whole organisation, so a
   * tool NAME can be a colleague of the customer.
   */
  | 'staff';

export interface RestoreResult {
  text: string;
  /**
   * True when the text still holds a token that was not restored: an unknown token (hallucinated
   * or injected) or, for `customer`, a `tool`/`model` token. A draft with this flag must go to a
   * human, never be sent or shown to the customer as is.
   */
  needsReview: boolean;
  /** The tokens left in `text`, in order of appearance. */
  unresolved: string[];
}

export interface RedactionSession {
  /** Ticket scope this session belongs to. */
  readonly scope: string;
  /**
   * Replaces PII in text that came from the ticket itself. The same value gets the same token
   * within a session. Token-shaped text in the input (a literal "[EMAIL_1]") is escaped to its
   * own token, so `restore(redact(x), 'internal').text === x` for every string.
   */
  redact(text: string): RedactedText;
  /** Same, for a tool result: its tokens get `tool` provenance and are never customer-restored. */
  redactToolOutput(tool: string, text: string): RedactedText;
  /**
   * Re-entry of model output into a later prompt (history, summaries). Tokens this session issued
   * stay as they are; token-shaped text it did not issue is escaped; new PII gets a `model` token.
   */
  fromModel(text: string): RedactedText;
  restore(text: string, audience?: RestoreAudience): RestoreResult;
  snapshot(): RedactionSnapshot;
  report(): RedactionReport;
}

export interface SessionOptions {
  /** Ticket id (or another stable scope). A snapshot from a different scope is refused. */
  scope: string;
  snapshot?: RedactionSnapshot;
}

export interface Redactor {
  /** One session per ticket, or per prompt when nothing needs to be restored later. */
  session(options: SessionOptions): RedactionSession;
}

export interface RedactorOptions {
  /**
   * Names the system already knows. Pass a **scoped** dictionary (the organisation's contacts,
   * the ticket's participants), not every contact in the system: it is rebuilt for each session,
   * and more than 50,000 entries (or 1.5 million characters in all) is refused. Each name is cut
   * to 128 characters and only its first 8 words are matched on their own. Evaluated each time a
   * session starts.
   *
   * A text that makes the dictionary produce more than `MAX_NAME_MATCHES` hits makes `redact`
   * throw `NameMatchLimitError`. Treat it as "do not send this text to a model".
   */
  names?: () => Iterable<string>;
  /** Ignore names shorter than this many characters. Default 3. */
  minNameLength?: number;
  /** Also redact each part of a multi-word name. Default true. */
  matchNameParts?: boolean;
  /** Longest text one call may redact (UTF-16 units). Longer input is refused. Default 1,000,000. */
  maxInputChars?: number;
}

export class RedactionInputTooLargeError extends Error {
  override readonly name = 'RedactionInputTooLargeError';
}
export class RedactionScopeError extends Error {
  override readonly name = 'RedactionScopeError';
}

const TOKEN_INDEX = /_([0-9]+)\]$/;
const DEFAULT_MAX_INPUT_CHARS = 1_000_000;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const minNameLength = options.minNameLength ?? 3;
  const matchParts = options.matchNameParts ?? true;
  const maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

  return {
    session({ scope, snapshot }) {
      if (snapshot !== undefined && snapshot.scope !== scope) {
        throw new RedactionScopeError('The snapshot belongs to a different scope');
      }
      const detectNames = createNameDetector({
        names: options.names?.() ?? [],
        minLength: minNameLength,
        matchParts,
      });
      const entries = new Map<string, TokenEntry>(Object.entries(snapshot?.tokens ?? {}));
      const tokenByValue = new Map<string, string>();
      const counters = new Map<RedactionKind, number>();
      const byKind: Partial<Record<RedactionKind, number>> = {};
      let total = 0;

      for (const [token, entry] of entries) {
        const kind = token.slice(1, token.lastIndexOf('_')) as RedactionKind;
        const index = Number(TOKEN_INDEX.exec(token)?.[1] ?? 0);
        counters.set(kind, Math.max(counters.get(kind) ?? 0, index));
        tokenByValue.set(`${kind}\u0000${entry.value}`, token);
      }

      const tokenFor = (
        kind: RedactionKind,
        value: string,
        origin: TokenOrigin,
        source: string | undefined,
      ): string => {
        const key = `${kind}\u0000${value}`;
        const existing = tokenByValue.get(key);
        if (existing !== undefined) {
          // A value the ticket itself contains is safe to restore whoever else mentioned it.
          const entry = entries.get(existing);
          if (entry !== undefined && origin === 'ticket' && entry.origin !== 'ticket') {
            entries.set(existing, { value: entry.value, origin: 'ticket' });
          }
          return existing;
        }
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        const token = `[${kind}_${String(next)}]`;
        entries.set(token, source === undefined ? { value, origin } : { value, origin, source });
        tokenByValue.set(key, token);
        return token;
      };

      const run = (
        text: string,
        origin: TokenOrigin,
        source: string | undefined,
        keepIssuedTokens: boolean,
      ): RedactedText => {
        if (text.length > maxInputChars) {
          throw new RedactionInputTooLargeError(
            `Text of ${String(text.length)} characters exceeds the limit of ${String(maxInputChars)}`,
          );
        }
        const view = buildView(text);
        const spans: Span[] = [
          ...detectTokenShapes(view.text),
          ...detectNumbers(view.text),
          ...detectEmails(view.text),
          ...detectNames(view),
        ];

        let output = '';
        let cursor = 0;
        for (const found of resolveOverlaps(spans, view.text.length)) {
          const from = view.starts[found.start] ?? 0;
          const to = view.ends[found.end - 1] ?? from;
          if (from < cursor || to <= from) continue;
          const original = text.slice(from, to);
          if (keepIssuedTokens && found.kind === 'LITERAL' && entries.has(original)) continue;
          output += text.slice(cursor, from) + tokenFor(found.kind, original, origin, source);
          cursor = to;
          total += 1;
          byKind[found.kind] = (byKind[found.kind] ?? 0) + 1;
        }
        return mintRedacted(output + text.slice(cursor));
      };

      return {
        scope,
        redact: (text) => run(text, 'ticket', undefined, false),
        redactToolOutput: (tool, text) => run(text, 'tool', tool, false),
        fromModel: (text) => run(text, 'model', undefined, true),

        restore(text, audience = 'customer') {
          const unresolved: string[] = [];
          const restored = text.replace(TOKEN_PATTERN, (token) => {
            const entry = entries.get(token);
            const allowed =
              audience === 'internal' ||
              entry?.origin === 'ticket' ||
              (audience === 'staff' && entry?.origin === 'tool' && token.startsWith('[NAME_'));
            if (entry === undefined || !allowed) {
              unresolved.push(token);
              return token;
            }
            return entry.value;
          });
          return { text: restored, needsReview: unresolved.length > 0, unresolved };
        },

        snapshot() {
          return { scope, tokens: Object.fromEntries(entries) };
        },

        report() {
          return { total, byKind: { ...byKind } };
        },
      };
    },
  };
}
