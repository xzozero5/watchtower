/** Who wrote the text of a fact (ADR-029 section 6): `system` is ours, `staff` and `customer` are free text. */
export type FactTrust = 'system' | 'staff' | 'customer';

export const UNTRUSTED_OPEN = '<untrusted_content>';
export const UNTRUSTED_CLOSE = '</untrusted_content>';

/**
 * Free text somebody else wrote (an alert, a handoff note, a timeline note) is data, not an instruction (T-400 C-14).
 * It goes between `<untrusted_content>` tags, and a tag of that name inside the text has its angle bracket replaced so
 * the text cannot close the block early. The whole wrapped string stays within `max` characters (the content is cut,
 * never the tags).
 */
export function wrapUntrusted(text: string, max = 1200): string {
  const safe = text
    .replaceAll(/<(\/?\s*untrusted_content\b)/gi, '‹$1')
    .replaceAll(/\s+/g, ' ')
    .trim();
  const room = Math.max(0, max - UNTRUSTED_OPEN.length - UNTRUSTED_CLOSE.length);
  const body =
    safe.length <= room ? safe : room === 0 ? '' : `${safe.slice(0, Math.max(0, room - 1))}…`;
  return `${UNTRUSTED_OPEN}${body}${UNTRUSTED_CLOSE}`;
}
