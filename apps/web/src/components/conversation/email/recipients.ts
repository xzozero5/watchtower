import type { EmailAddress } from '@watchtower/shared';

const ADDRESS = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 320 && ADDRESS.test(value);
}

/**
 * Reads what a person typed or pasted into a recipient box: `a@x.org`, `Name <a@x.org>` or a list
 * separated by commas, semicolons or line breaks. Returns the good ones and the text of the bad ones.
 */
export function parseRecipients(text: string): { valid: EmailAddress[]; invalid: string[] } {
  const valid: EmailAddress[] = [];
  const invalid: string[] = [];
  // Split on separators that are not inside a quoted name or an angle bracket.
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') angle = true;
    else if (!quoted && char === '>') angle = false;
    if (!quoted && !angle && (char === ',' || char === ';' || char === '\n')) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);

  for (const raw of parts) {
    const part = raw.trim();
    if (part === '') continue;
    const named = /^(.*?)\s*<([^<>]+)>$/.exec(part);
    const address = (named?.[2] ?? part).trim();
    const name = named?.[1]?.trim().replace(/^"|"$/g, '').trim() ?? '';
    if (isEmailAddress(address)) valid.push(name === '' ? { address } : { address, name });
    else invalid.push(part);
  }
  return { valid, invalid };
}

/** Adds addresses that are not in the list yet (compared without case). */
export function addRecipients(
  list: readonly EmailAddress[],
  extra: readonly EmailAddress[],
): EmailAddress[] {
  const seen = new Set(list.map((entry) => entry.address.toLowerCase()));
  const next = [...list];
  for (const entry of extra) {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(entry);
  }
  return next;
}
