import { createRedactor, type RedactionSession } from '@watchtower/ai';
import { maskEmail } from '@watchtower/shared';

/**
 * Masking for a caller who may read tickets but not personal data: the `dev` role, `ticket.read.masked`
 * (T-137). One place decides how a value is hidden, so a route that serves a masked reader cannot invent
 * its own rule:
 *  - an email address keeps its first letter and its domain (`maskEmail`, the same rule the portal uses);
 *  - a phone number keeps its last two digits;
 *  - a person's name keeps its initials;
 *  - free text (a subject, a message, an AI summary) goes through the redactor that runs before the LLM
 *    (N4): addresses, numbers, ids and the names of the ticket's people become `[EMAIL_1]`, `[NAME_1]`...
 *
 * It never returns the original of anything it was asked to hide, and it fails closed: text the redactor
 * refuses (too long, too many name hits) is replaced by a fixed notice, not passed through.
 */

export const MASKED_TEXT_UNAVAILABLE = '[text hidden: could not be masked]';
export const MASKED_ATTACHMENT_NAME = '[attachment]';

export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return '***';
  return `***${digits.slice(-2)}`;
}

/** `Somchai Demo` becomes `S*** D***`. */
export function maskName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0) return '***';
  return words.map((word) => `${String.fromCodePoint(word.codePointAt(0) ?? 0x2a)}***`).join(' ');
}

export function maskAddress(email: string | null | undefined): string | null {
  return email === null || email === undefined ? null : maskEmail(email);
}

/** Masks the text of one ticket (or one page of tickets): the same value gets the same token throughout. */
export interface MaskingSession {
  text(value: string): string;
  /** Same, for a value that may be absent. */
  textOrNull(value: string | null | undefined): string | null;
  readonly name: typeof maskName;
  readonly email: typeof maskAddress;
  readonly phone: typeof maskPhone;
}

export function createMaskingSession(scope: string, names: readonly string[]): MaskingSession {
  const known = names.filter((name) => name.trim() !== '');
  const redactor = createRedactor({ names: () => known });
  let session: RedactionSession | undefined;
  const text = (value: string): string => {
    try {
      session ??= redactor.session({ scope });
      return session.redact(value);
    } catch {
      // Too long, or too many name hits: do not show the original.
      return MASKED_TEXT_UNAVAILABLE;
    }
  };
  return {
    text,
    textOrNull: (value) => (value === null || value === undefined ? null : text(value)),
    name: maskName,
    email: maskAddress,
    phone: maskPhone,
  };
}
