/**
 * HTML email -> safe HTML + plain text, in one pass (R-2.5: "HTML sanitized; inline images
 * preserved").
 *
 * This is an allow-list *rebuild*, not a deny-list filter: the input is tokenised, and the output is
 * assembled only from allow-listed elements and attributes, with every text node and attribute
 * value escaped. Nothing from the input is copied through verbatim, so an unknown or malformed
 * construct can only disappear, never become active content. Scripts, `<style>` blocks, frames,
 * forms and event handlers are dropped. Formatting survives the way Gmail shows it (T-171): the
 * `style` attribute is rebuilt through the shared CSS allow-list (colours, fonts, spacing, borders; no
 * `url()`, no positioning), and the legacy `align` / `bgcolor` / `<font>` / `<center>` become the same.
 * Images survive as `cid:` references, which resolve to attachment parts of the same message. A remote
 * image is never given a `src` here: with `keepRemoteImages` its address is kept as inert
 * `data-remote-src`, which only the reader's "Display images below" turns into a request.
 */
import { safeColor, sanitizeInlineStyle } from '@watchtower/shared';

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  euro: '€',
  baht: '฿',
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,8});/g,
    (whole, body) => {
      const entity = body as string;
      if (entity.startsWith('#')) {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[entity] ?? whole;
    },
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Control characters other than tab / newline / carriage return, and bidi overrides. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
const UNSAFE_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;

// ---------------------------------------------------------------------------------------------
// Tokenizer

type Token =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'open';
      readonly name: string;
      readonly attrs: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly type: 'close'; readonly name: string };

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext']);

function isNameStart(char: string): boolean {
  return /[A-Za-z]/.test(char);
}

function* tokenize(html: string): Generator<Token> {
  let i = 0;
  let textStart = 0;
  const length = html.length;
  const flushText = function* (end: number): Generator<Token> {
    if (end > textStart) yield { type: 'text', value: html.slice(textStart, end) };
  };

  while (i < length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html.charAt(lt + 1);

    if (html.startsWith('<!--', lt)) {
      yield* flushText(lt);
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? length : end + 3;
      textStart = i;
      continue;
    }
    if (next === '!' || next === '?') {
      yield* flushText(lt);
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? length : end + 1;
      textStart = i;
      continue;
    }
    const closing = next === '/';
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isNameStart(html.charAt(nameStart))) {
      // A stray "<" is text.
      i = lt + 1;
      continue;
    }

    let cursor = nameStart;
    while (cursor < length && /[^\s/>]/.test(html.charAt(cursor))) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attrs = new Map<string, string>();
    let selfClosing = false;
    let terminated = false;

    while (cursor < length) {
      const char = html.charAt(cursor);
      if (char === '>') {
        cursor += 1;
        terminated = true;
        break;
      }
      if (char === '/') {
        selfClosing = html.charAt(cursor + 1) === '>';
        cursor += 1;
        continue;
      }
      if (/\s/.test(char)) {
        cursor += 1;
        continue;
      }
      const attrStart = cursor;
      while (cursor < length && /[^\s=/>]/.test(html.charAt(cursor))) cursor += 1;
      const attrName = html.slice(attrStart, cursor).toLowerCase();
      while (cursor < length && /\s/.test(html.charAt(cursor))) cursor += 1;
      let attrValue = '';
      if (html.charAt(cursor) === '=') {
        cursor += 1;
        while (cursor < length && /\s/.test(html.charAt(cursor))) cursor += 1;
        const quote = html.charAt(cursor);
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, cursor + 1);
          if (end === -1) {
            cursor = length;
            break;
          }
          attrValue = html.slice(cursor + 1, end);
          cursor = end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && /[^\s>]/.test(html.charAt(cursor))) cursor += 1;
          attrValue = html.slice(valueStart, cursor);
        }
      }
      if (attrName !== '' && !attrs.has(attrName)) attrs.set(attrName, decodeEntities(attrValue));
    }

    yield* flushText(lt);
    if (!terminated) {
      // Truncated tag at end of input: drop it.
      textStart = length;
      break;
    }
    i = cursor;
    textStart = cursor;

    if (closing) {
      yield { type: 'close', name };
      continue;
    }
    yield { type: 'open', name, attrs, selfClosing };
    if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
      const end = new RegExp(`</${name}[\\s>/]`, 'i').exec(html.slice(i));
      const skipTo = end === null ? length : i + end.index;
      i = skipTo;
      textStart = skipTo;
    }
  }
  yield* flushText(length);
}

// ---------------------------------------------------------------------------------------------
// Sanitiser

const VOID_ELEMENTS = new Set([
  'br',
  'hr',
  'img',
  'wbr',
  'input',
  'meta',
  'link',
  'source',
  'area',
]);

/** Dropped together with everything inside. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'head',
  'title',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'svg',
  'math',
  'noscript',
  'template',
  'form',
  'select',
  'textarea',
  'button',
  'audio',
  'video',
  'canvas',
  'xmp',
  'plaintext',
]);

const ALLOWED_ELEMENTS = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'sub',
  'sup',
  'small',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'a',
  'img',
  'center',
  'font',
]);

/** Legacy presentation attributes kept as they are (digits or keywords only). */
const KEYWORD_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  p: ['align'],
  div: ['align'],
  h1: ['align'],
  h2: ['align'],
  h3: ['align'],
  h4: ['align'],
  h5: ['align'],
  h6: ['align'],
  table: ['align'],
  tr: ['align', 'valign'],
  td: ['align', 'valign'],
  th: ['align', 'valign'],
};
const KEYWORD_VALUE = /^(left|right|center|justify|top|middle|bottom|baseline)$/i;
const DIGIT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  table: ['border', 'cellpadding', 'cellspacing'],
};
const MAX_REMOTE_IMAGES = 200;

/** The `style` text of one element: its own declarations, plus what legacy attributes meant. */
function styleOf(name: string, attrs: ReadonlyMap<string, string>): string {
  const own = sanitizeInlineStyle(attrs.get('style') ?? '');
  const extra: string[] = [];
  if (name === 'center') extra.push('text-align:center');
  if (name === 'font') {
    const color = safeColor(attrs.get('color') ?? '');
    if (color !== null) extra.push(`color:${color}`);
    const face = sanitizeInlineStyle(`font-family:${attrs.get('face') ?? ''}`);
    if (face !== '') extra.push(face);
  }
  if (['table', 'tr', 'td', 'th'].includes(name)) {
    const background = safeColor(attrs.get('bgcolor') ?? '');
    if (background !== null) extra.push(`background-color:${background}`);
  }
  // The element's own style comes last so it wins, as it does in a browser.
  return [...extra, own].filter((part) => part !== '').join(';');
}

const BLOCK_ELEMENTS = new Set([
  'center',
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'tr',
  'caption',
  'hr',
]);

const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function isSafeHref(value: string): boolean {
  // Browsers ignore tabs / newlines / control characters inside a scheme ("java\tscript:").
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  const compact = value.replace(/[\u0000- \u007f-\u009f]+/g, '');
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(compact);
  if (match?.[1] === undefined) return false;
  return SAFE_LINK_PROTOCOLS.has(match[1].toLowerCase());
}

function cleanDigits(value: string | undefined, max: number): string | null {
  if (value === undefined || !/^\d{1,4}$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return number <= max ? String(number) : null;
}

export interface SanitizeOptions {
  /** Stop emitting after this many output characters of safe HTML. Default 2,000,000. */
  readonly maxOutputChars?: number;
  /** Elements nested deeper than this are unwrapped. Default 60. */
  readonly maxDepth?: number;
  /**
   * Keep the address of remote `http(s)` images as `data-remote-src` (no `src`, so nothing loads). For
   * mail we received; mail we send never carries remote images. Default false.
   */
  readonly keepRemoteImages?: boolean;
}

export interface SanitizedHtml {
  /** Safe HTML fragment (no `<html>` / `<head>` / `<body>`). */
  readonly html: string;
  /** Plain-text rendering of the same content. */
  readonly text: string;
  /** `cid:` content ids (without the scheme, lower-case) referenced by `<img>`. */
  readonly inlineContentIds: readonly string[];
  readonly remoteImagesBlocked: number;
  readonly truncated: boolean;
}

interface OpenElement {
  readonly name: string;
  readonly closeText: string;
}

class TextBuilder {
  readonly #parts: string[] = [];
  /** Consecutive "\n" at the end of the output. Starts high so the text never begins blank. */
  #trailingNewlines = 2;
  #lineStart = true;
  #afterMarker = false;
  #pendingSpace = false;
  quoteDepth = 0;

  #push(chunk: string): void {
    this.#parts.push(chunk);
    this.#trailingNewlines = chunk === '\n' ? this.#trailingNewlines + 1 : 0;
  }

  newline(count = 1): void {
    while (this.#trailingNewlines < count) this.#push('\n');
    this.#lineStart = true;
    this.#afterMarker = false;
    this.#pendingSpace = false;
  }

  #startLine(): void {
    if (!this.#lineStart) return;
    if (this.quoteDepth > 0) this.#push('> '.repeat(this.quoteDepth));
    this.#lineStart = false;
    this.#afterMarker = this.quoteDepth > 0;
  }

  write(text: string, preserve: boolean): void {
    if (text === '') return;
    if (preserve) {
      for (const char of text) {
        if (char === '\n') {
          this.#push('\n');
          this.#lineStart = true;
          this.#afterMarker = false;
        } else {
          this.#startLine();
          this.#push(char);
        }
      }
      return;
    }
    const collapsed = text.replace(/\s+/g, ' ');
    if (collapsed.startsWith(' ')) this.#pendingSpace = true;
    const body = collapsed.trim();
    if (body === '') return;
    const wasLineStart = this.#lineStart;
    this.#startLine();
    if (this.#pendingSpace && !wasLineStart && !this.#afterMarker) this.#push(' ');
    this.#pendingSpace = collapsed.endsWith(' ');
    this.#afterMarker = false;
    this.#push(body);
  }

  /** Text that is not source content (list markers, link targets). */
  literal(text: string, marker = false): void {
    this.#startLine();
    this.#push(text);
    this.#pendingSpace = false;
    this.#afterMarker = marker;
  }

  toString(): string {
    return this.#parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\u00a0/g, ' ')
      .trim();
  }
}

export function sanitizeHtml(input: string, options: SanitizeOptions = {}): SanitizedHtml {
  const maxOutput = options.maxOutputChars ?? 2_000_000;
  const maxDepth = options.maxDepth ?? 60;

  const out: string[] = [];
  let outLength = 0;
  let truncated = false;
  const text = new TextBuilder();
  const stack: OpenElement[] = [];
  const dropStack: string[] = [];
  const inlineContentIds: string[] = [];
  let remoteImagesBlocked = 0;
  let preDepth = 0;
  const linkHrefs: (string | null)[] = [];
  const linkTexts: string[] = [];

  const emit = (chunk: string): void => {
    if (truncated) return;
    if (outLength + chunk.length > maxOutput) {
      truncated = true;
      return;
    }
    out.push(chunk);
    outLength += chunk.length;
  };

  const closeTop = (): void => {
    const top = stack.pop();
    if (top === undefined) return;
    emit(top.closeText);
    afterClose(top.name);
  };

  const afterClose = (name: string): void => {
    if (name === 'pre') preDepth = Math.max(0, preDepth - 1);
    if (name === 'blockquote') text.quoteDepth = Math.max(0, text.quoteDepth - 1);
    if (name === 'a') {
      const href = linkHrefs.pop() ?? null;
      const shown = linkTexts.pop() ?? '';
      if (href !== null && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        if (shown.trim() !== href) text.literal(` (${href})`);
      }
    }
    if (name === 'td' || name === 'th') text.literal(' ');
    if (BLOCK_ELEMENTS.has(name)) text.newline(name === 'p' || name.startsWith('h') ? 2 : 1);
  };

  for (const token of tokenize(input)) {
    if (token.type === 'text') {
      if (dropStack.length > 0) continue;
      const decoded = decodeEntities(token.value).replace(UNSAFE_TEXT_CHARS, '');
      emit(escapeText(decoded));
      text.write(decoded, preDepth > 0);
      const last = linkTexts.length - 1;
      if (last >= 0) linkTexts[last] = `${linkTexts[last] ?? ''}${decoded}`;
      continue;
    }

    if (token.type === 'close') {
      const top = dropStack.at(-1);
      if (top !== undefined) {
        if (top === token.name) dropStack.pop();
        continue;
      }
      if (!ALLOWED_ELEMENTS.has(token.name)) continue;
      const position = stack.map((element) => element.name).lastIndexOf(token.name);
      if (position === -1) continue;
      while (stack.length > position) closeTop();
      continue;
    }

    // Open tag.
    if (dropStack.length > 0) {
      if (dropStack.at(-1) === token.name && !token.selfClosing && !VOID_ELEMENTS.has(token.name)) {
        dropStack.push(token.name);
      }
      continue;
    }
    if (DROP_WITH_CONTENT.has(token.name)) {
      if (!token.selfClosing) dropStack.push(token.name);
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(token.name)) continue; // unwrap: keep the children

    const { attrs } = token;
    const name = token.name;
    // `<font>` and `<center>` are written as `<span>` / `<div>` with the same look as a style.
    const tag = name === 'font' ? 'span' : name === 'center' ? 'div' : name;

    if (name === 'br') {
      emit('<br>');
      text.newline();
      continue;
    }
    if (name === 'hr') {
      emit('<hr>');
      text.newline();
      text.literal('---');
      text.newline();
      continue;
    }
    if (name === 'img') {
      const src = (attrs.get('src') ?? '').trim();
      if (/^cid:/i.test(src)) {
        const cid = src.slice(4).replace(/^<|>$/g, '').toLowerCase();
        if (cid !== '' && !/[\s"'<>]/.test(cid)) {
          inlineContentIds.push(cid);
          const parts = [`src="cid:${escapeAttribute(cid)}"`];
          const alt = attrs.get('alt');
          if (alt !== undefined)
            parts.push(`alt="${escapeAttribute(alt.replace(UNSAFE_TEXT_CHARS, ''))}"`);
          for (const dimension of ['width', 'height'] as const) {
            const value = cleanDigits(attrs.get(dimension), 5000);
            if (value !== null) parts.push(`${dimension}="${value}"`);
          }
          emit(`<img ${parts.join(' ')}>`);
          text.write(`[image${alt === undefined || alt === '' ? '' : `: ${alt}`}]`, false);
        }
      } else if (src !== '') {
        remoteImagesBlocked += 1;
        const alt = attrs.get('alt');
        if (
          options.keepRemoteImages === true &&
          /^https?:\/\//i.test(src) &&
          src.length <= 2000 &&
          !/[\s"'<>\\]/.test(src) &&
          remoteImagesBlocked <= MAX_REMOTE_IMAGES
        ) {
          const parts = [`data-remote-src="${escapeAttribute(src)}"`];
          if (alt !== undefined)
            parts.push(`alt="${escapeAttribute(alt.replace(UNSAFE_TEXT_CHARS, ''))}"`);
          for (const dimension of ['width', 'height'] as const) {
            const value = cleanDigits(attrs.get(dimension), 5000);
            if (value !== null) parts.push(`${dimension}="${value}"`);
          }
          emit(`<img ${parts.join(' ')}>`);
        }
        if (alt !== undefined && alt.trim() !== '') text.write(`[image: ${alt}]`, false);
      }
      continue;
    }

    if (stack.length >= maxDepth) continue;

    let open = `<${tag}`;
    if (name === 'a') {
      const href = (attrs.get('href') ?? '').trim();
      if (!isSafeHref(href)) {
        // No usable link: unwrap but keep the link-text bookkeeping balanced.
        linkHrefs.push(null);
        linkTexts.push('');
        stack.push({ name, closeText: '' });
        continue;
      }
      open += ` href="${escapeAttribute(href)}"`;
      const title = attrs.get('title');
      if (title !== undefined)
        open += ` title="${escapeAttribute(title.replace(UNSAFE_TEXT_CHARS, ''))}"`;
      open += ' rel="noopener noreferrer nofollow" target="_blank"';
      linkHrefs.push(href);
      linkTexts.push('');
    } else if (name === 'td' || name === 'th') {
      for (const span of ['colspan', 'rowspan'] as const) {
        const value = cleanDigits(attrs.get(span), 1000);
        if (value !== null) open += ` ${span}="${value}"`;
      }
    } else if (name === 'ol') {
      const start = cleanDigits(attrs.get('start'), 100000);
      if (start !== null) open += ` start="${start}"`;
    }
    const dir = attrs.get('dir')?.toLowerCase();
    if (dir === 'rtl' || dir === 'ltr') open += ` dir="${dir}"`;
    for (const attribute of KEYWORD_ATTRIBUTES[name] ?? []) {
      const value = (attrs.get(attribute) ?? '').trim();
      if (KEYWORD_VALUE.test(value)) open += ` ${attribute}="${value.toLowerCase()}"`;
    }
    for (const attribute of DIGIT_ATTRIBUTES[name] ?? []) {
      const value = cleanDigits(attrs.get(attribute), 1000);
      if (value !== null) open += ` ${attribute}="${value}"`;
    }
    if (name === 'table' || name === 'td' || name === 'th') {
      const width = (attrs.get('width') ?? '').trim();
      if (/^\d{1,4}%?$/.test(width)) open += ` width="${width}"`;
    }
    const style = styleOf(name, attrs);
    if (style !== '') open += ` style="${escapeAttribute(style)}"`;
    open += '>';

    if (name === 'li') text.literal('- ', true);
    if (name === 'pre') preDepth += 1;
    if (name === 'blockquote') {
      text.newline();
      text.quoteDepth += 1;
    }
    if (BLOCK_ELEMENTS.has(name) && name !== 'li' && name !== 'blockquote') text.newline();

    emit(open);
    if (token.selfClosing) {
      emit(`</${tag}>`);
      afterClose(name);
    } else {
      stack.push({ name, closeText: `</${tag}>` });
    }
  }
  while (stack.length > 0) closeTop();

  return {
    html: out.join(''),
    text: text.toString(),
    inlineContentIds: [...new Set(inlineContentIds)],
    remoteImagesBlocked,
    truncated,
  };
}
