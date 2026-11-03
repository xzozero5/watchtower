/**
 * "Show trimmed content": splits a reply from the history it quotes, as Gmail does. The sanitised
 * markup has lost its class names, so the quote is found by shape: the first `<blockquote>` plus the
 * "On ... wrote:" line before it, and everything after.
 */

export interface QuotedSplit {
  /** What the sender wrote. */
  readonly visible: string;
  /** The history below it; null when the message quotes nothing (or is nothing but a quote). */
  readonly quoted: string | null;
}

const ATTRIBUTION =
  /(^|\s)(wrote|writes):?\s*$|เขียนว่า|ได้เขียน|^(from|sent|ผู้ส่ง):\s|^-{2,}\s*(original message|forwarded message)|^_{8,}$/i;

function isAttribution(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length < 400 && ATTRIBUTION.test(trimmed);
}

function hasContent(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').trim() !== '';
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return el.textContent.trim() !== '' || el.querySelector('img,table,hr') !== null;
}

export function splitQuotedHtml(html: string): QuotedSplit {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return { visible: html, quoted: null };
  const quote = Array.from(root.querySelectorAll('blockquote')).find(
    (el) => el.parentElement?.closest('blockquote') == null,
  );
  if (!quote) return { visible: html, quoted: null };

  // Start at the quote; take the attribution line just before it; climb while the start is the
  // first thing in its parent, so the whole "gmail_quote" wrapper goes, not just its inside.
  let start: Node = quote;
  const before = start.previousSibling;
  let previous: Node | null = before;
  while (previous && !hasContent(previous)) previous = previous.previousSibling;
  if (previous && isAttribution(previous.textContent ?? '')) start = previous;
  while (start.parentNode && start.parentNode !== root) {
    let sibling = start.previousSibling;
    while (sibling && !hasContent(sibling)) sibling = sibling.previousSibling;
    if (sibling) break;
    start = start.parentNode;
  }

  const holder = doc.createElement('div');
  // Everything from `start` to the end of the message is history, at every level up to the root.
  let level: Node | null = start;
  while (level) {
    const parent: Node | null = level.parentNode;
    const next: ChildNode | null = level.nextSibling;
    if (level === start) holder.appendChild(level);
    let cursor: ChildNode | null = next;
    while (cursor) {
      const following: ChildNode | null = cursor.nextSibling;
      holder.appendChild(cursor);
      cursor = following;
    }
    level = parent === root ? null : parent;
  }

  const visibleHasContent = Array.from(root.childNodes).some(hasContent);
  if (!visibleHasContent) return { visible: html, quoted: null };
  return { visible: root.innerHTML, quoted: holder.innerHTML };
}

const TEXT_ATTRIBUTION = [
  /^on .{5,300}wrote:\s*$/i,
  /^ใน.{5,300}เขียน(ว่า)?:?\s*$/,
  /^-{2,}\s*(original message|forwarded message)\s*-{0,}\s*$/i,
  /^_{8,}\s*$/,
  /^from:\s.+/i,
  /^>/,
];

export function splitQuotedText(text: string): QuotedSplit {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    // "On Mon, 3 Nov 2026, Alex <a@x> wrote:" is often folded over two lines.
    const joined = `${line} ${(lines[index + 1] ?? '').trim()}`.trim();
    const hit =
      TEXT_ATTRIBUTION.some((pattern) => pattern.test(line)) ||
      (/^on /i.test(line) && TEXT_ATTRIBUTION[0]?.test(joined) === true);
    if (!hit) continue;
    const visible = lines.slice(0, index).join('\n').trim();
    if (visible === '') return { visible: text, quoted: null };
    return { visible, quoted: lines.slice(index).join('\n').trim() };
  }
  return { visible: text, quoted: null };
}
