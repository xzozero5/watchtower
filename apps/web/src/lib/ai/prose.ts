/**
 * Small, pure helpers for text the AI wrote (docs/design/less-text-ai-assistant.md section 4):
 * making markdown readable as plain text, guessing which language a sentence is in, and turning an
 * intent key into words. Nothing here builds HTML: the result is always a plain string that React
 * puts in the page as text.
 */

/**
 * Markdown to plain text for a short snippet. It removes the marks (`##`, `**`, `_`, backticks,
 * list bullets, quote marks, link and image syntax, fences, raw tags) and keeps the words, then
 * collapses the whitespace. It is not a markdown renderer and does not need to be: a snippet is a
 * quote to recognise the source by, and the source itself is one click away.
 */
const ESCAPE_OPEN = '';
const ESCAPE_CLOSE = '';

export function stripMarkdown(markdown: string): string {
  return (
    markdown
      // An escaped character (`\*`) is a letter, not a mark: set it aside until the marks are gone.
      .replace(
        /\\([\\`*_{}[\]()#+\-.!>|~])/g,
        (_, char: string) => `${ESCAPE_OPEN}${String(char.charCodeAt(0))}${ESCAPE_CLOSE}`,
      )
      // Fenced code: keep the code, drop the fences and the language tag.
      .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
      // Images and links: keep the label, drop the address.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Reference-style links and autolinks.
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      // Raw HTML tags and comments are text to drop, never markup to keep.
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      // Headings, quotes, bullets, numbered lists, rules and table pipes at the start of a line.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+[.)]\s+/gm, '')
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '')
      .replace(/\s*\|\s*/g, ' · ')
      // Emphasis and inline code.
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      // The escaped characters come back as themselves, now the marks are gone.
      .replace(new RegExp(`${ESCAPE_OPEN}(\\d+)${ESCAPE_CLOSE}`, 'g'), (_, code: string) =>
        String.fromCharCode(Number(code)),
      )
  );
}

/** `th` when the text is mostly Thai script, else `en`. Good enough to label a sentence, not to translate. */
export function detectProseLang(text: string): 'th' | 'en' {
  let thai = 0;
  let latin = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x0e00 && code <= 0x0e7f) thai += 1;
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1;
  }
  return thai > latin ? 'th' : 'en';
}

/**
 * An intent key in words, for when the api sent only the key (`billing_report` becomes
 * `Billing report`). A stopgap `[ASSUMED]`: the api is to send the name in the viewer's language
 * (T-134), and then this is never reached.
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1);
}
