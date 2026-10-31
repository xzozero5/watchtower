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
declare const redactedBrand: unique symbol;

export type RedactedText = string & { readonly [redactedBrand]: true };

/** For the redactor only. Do not import elsewhere (a test enforces it). */
export function mintRedacted(value: string): RedactedText {
  // The only cast to RedactedText in the repository; the lint rule in tools/eslint/boundaries.mjs
  // forbids it everywhere else (R-6), and reportUnusedDisableDirectives keeps this one honest.
  // eslint-disable-next-line no-restricted-syntax -- sole mint point
  return value as RedactedText;
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
