/**
 * `RedactedText` is text that has been through the redactor (N4). The brand symbol is not
 * exported, so no other module can build the type without importing `mintRedacted`, and
 * `redaction/redacted-text.test.ts` fails if any file other than the redactor imports it. The
 * provider ports accept only this type, so passing a plain string to an LLM or embedding call does
 * not compile.
 *
 * The brand is erased at runtime, so there is deliberately no `isRedactedText` guard: a guard
 * could only answer "is a string", which would be a lie.
 */
import {
  isParsedPromptFile,
  PromptFileError,
  splitPromptSlots,
  type PromptFile,
} from '../prompts.js';

declare const redactedBrand: unique symbol;

export type RedactedText = string & { readonly [redactedBrand]: true };

/** For the redactor only. Do not import elsewhere (a test enforces it). */
export function mintRedacted(value: string): RedactedText {
  // The only cast to RedactedText in the repository; the lint rule in tools/eslint/boundaries.mjs
  // forbids it everywhere else (R-6), and reportUnusedDisableDirectives keeps this one honest.
  // eslint-disable-next-line watchtower/no-redacted-text-cast -- sole mint point
  return value as RedactedText;
}

/**
 * Renders a prompt from the catalog. The literal template text is our own versioned file, so it is
 * trusted and not scanned (scanning it let a contact called "Customer" rewrite `new_customer_issue`
 * inside the answer format). Every `{{slot}}` value is outside data and goes through `redact`.
 * It accepts only a `PromptFile` made by `parsePromptFile`, never a raw string, so it cannot be
 * used to pass customer text around the redactor (N4).
 */
export function renderTrustedPrompt(
  file: PromptFile,
  values: Readonly<Record<string, string>>,
  redact: (text: string) => RedactedText,
): RedactedText {
  if (!isParsedPromptFile(file)) {
    throw new PromptFileError('renderTrustedPrompt accepts only a prompt read from the catalog');
  }
  const parts = splitPromptSlots(file.body).map((piece, index) => {
    if (index % 2 === 0) return mintRedacted(piece);
    const value = values[piece];
    if (value === undefined) throw new PromptFileError(`Missing prompt value: ${piece}`);
    return redact(value);
  });
  return mintRedacted(parts.join(''));
}

/**
 * Joins already redacted pieces. Safe without a second pass: every piece went through the
 * redactor, and the separator is chosen by the caller from our own code.
 */
export function joinRedacted(
  parts: readonly RedactedText[],
  separator: '\n' | '\n\n' | ' ' = '\n',
): RedactedText {
  return mintRedacted(parts.join(separator));
}
