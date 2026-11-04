/**
 * HTML helpers for email: a second, browser-side allow-list rebuild of the markup (the server has
 * already done one, so this is defence in depth and the place the image policy lives), plus
 * text <-> HTML conversions for the composer.
 *
 * Nothing from the input is copied through: the output is built from allow-listed elements and
 * attributes only, so an unknown construct can disappear but never become active content. Scripts,
 * `<style>` blocks, frames, forms and event handlers never survive. The `style` attribute is rebuilt
 * through the shared CSS allow-list (colours, fonts, spacing; no `url()`, no positioning) so a mail
 * looks like it does in Gmail (T-171). Links open in a new tab with `noopener`; images are `cid:`
 * (resolved by the caller), `data:image/*`, or remote only when the reader asked for images (Gmail's
 * "Display images below"): the server keeps a remote address as the inert `data-remote-src`.
 */
import { safeColor, sanitizeInlineStyle } from '@watchtower/shared';

const ALLOWED = new Set([
  'a',
  'abbr',
  'b',
  'big',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'tt',
  'u',
  'ul',
]);

/** Elements whose content is dropped with them (every other unknown element is unwrapped). */
const DROPPED_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'select',
  'textarea',
  'button',
  'audio',
  'video',
  'canvas',
  'svg',
  'math',
  'template',
  'head',
  'title',
  'noscript',
  'link',
  'meta',
  'base',
  'xmp',
  'plaintext',
]);

const GLOBAL_ATTRIBUTES = ['title', 'dir', 'lang', 'style'] as const;
const ELEMENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'],
  table: ['width', 'align', 'border', 'cellpadding', 'cellspacing', 'bgcolor'],
  tr: ['align', 'valign'],
  p: ['align'],
  div: ['align'],
  ol: ['start', 'type'],
};

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
const MAX_DEPTH = 80;

export interface SanitizeEmailOptions {
  /** Load remote (`http(s)`) images. Off by default: they tell the sender that, and when, you read it. */
  readonly allowRemoteImages?: boolean;
  /**
   * Keep the safe subset of `style` attributes. Default true; the editor turns it off for pasted
   * text so a paste brings the words and the structure, not another page's fonts and colours.
   */
  readonly styles?: boolean;
  /** Turns a `cid:` content id (no scheme, lower-case) into a URL the page may load, or null. */
  readonly resolveCid?: (contentId: string) => string | null;
  /**
   * Turns the position of a remote image among the `data-remote-src` of the mail (document order, the same
   * order the api counts in) into a URL the page may load, or null while it is not there yet (T-175: the
   * page's CSP allows no remote host, so the api fetches the picture and the caller holds it as a blob URL).
   * Used only together with `allowRemoteImages`. Without it a remote address goes into `src` as written.
   */
  readonly resolveRemote?: (index: number) => string | null;
}

export interface SanitizedEmailHtml {
  readonly html: string;
  /** Remote images held back; the reader can choose to show them. */
  readonly blockedImages: number;
  /** `cid:` ids the markup refers to (lower-case), so the caller can fetch only those. */
  readonly contentIds: readonly string[];
  /** How many pictures carry a `data-remote-src`; the api serves them by position `0..n-1`. */
  readonly remoteImageCount: number;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function isSafeLink(value: string): boolean {
  // Control characters and spaces inside a scheme ("java\tscript:") are ignored by browsers.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the purpose
  const compact = value.replace(/[\u0000- \u007f-\u009f]+/g, '');
  return SAFE_LINK.test(compact);
}

export function sanitizeEmailHtml(
  input: string,
  options: SanitizeEmailOptions = {},
): SanitizedEmailHtml {
  const source = parse(input);
  const target = document.implementation.createHTMLDocument('');
  const root = target.createElement('div');
  let blocked = 0;
  const contentIds = new Set<string>();
  // The api addresses a remote picture by its position among the `data-remote-src` of the stored HTML.
  const remoteIndex = new Map<Element, number>();
  Array.from(source.querySelectorAll('img[data-remote-src]')).forEach((element, index) => {
    remoteIndex.set(element, index);
  });

  const copyImage = (element: Element): Element | null => {
    const src = (element.getAttribute('src') ?? '').trim();
    const image = target.createElement('img');
    image.setAttribute('alt', element.getAttribute('alt') ?? '');
    for (const attribute of ['width', 'height']) {
      const value = element.getAttribute(attribute);
      if (value !== null && /^\d{1,4}$/.test(value.trim())) {
        image.setAttribute(attribute, value.trim());
      }
    }
    if (/^cid:/i.test(src)) {
      const id = src.slice(4).replace(/^<|>$/g, '').trim().toLowerCase();
      contentIds.add(id);
      const url = options.resolveCid?.(id) ?? null;
      if (url === null) image.setAttribute('data-cid', id);
      else image.setAttribute('src', url);
      return image;
    }
    if (SAFE_DATA_IMAGE.test(src)) {
      image.setAttribute('src', src.replace(/\s+/g, ''));
      return image;
    }
    // The server keeps a remote address as `data-remote-src` (no `src`); an image whose `src` is already
    // remote (older stored mail) is treated the same.
    const remote = /^https?:\/\//i.test(src)
      ? src
      : (element.getAttribute('data-remote-src') ?? '').trim();
    if (/^https?:\/\//i.test(remote)) {
      if (options.allowRemoteImages !== true) {
        blocked += 1;
        image.setAttribute('data-blocked', '1');
        return image;
      }
      if (options.resolveRemote !== undefined) {
        const position = remoteIndex.get(element);
        // No position (an address in `src`, older stored mail) means the api cannot serve it: keep the placeholder.
        if (position === undefined) {
          image.setAttribute('data-blocked', '1');
          return image;
        }
        const proxied = options.resolveRemote(position);
        if (proxied === null) {
          image.setAttribute('data-blocked', '1');
          return image;
        }
        image.setAttribute('src', proxied);
        image.setAttribute('loading', 'lazy');
        return image;
      }
      image.setAttribute('src', remote);
      image.setAttribute('referrerpolicy', 'no-referrer');
      image.setAttribute('loading', 'lazy');
      return image;
    }
    return null; // relative, javascript:, file:, ...: nothing to show
  };

  const styleOfElement = (element: Element, name: string): string => {
    const parts: string[] = [];
    if (name === 'table' || name === 'td' || name === 'th') {
      const background = safeColor(element.getAttribute('bgcolor') ?? '');
      if (background !== null) parts.push(`background-color:${background}`);
    }
    if (options.styles !== false) {
      const own = sanitizeInlineStyle(element.getAttribute('style') ?? '');
      if (own !== '') parts.push(own);
    }
    return parts.join(';');
  };

  const copyChildren = (from: Node, to: Node, depth: number): void => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        to.appendChild(target.createTextNode(child.nodeValue ?? ''));
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        copyElement(child as Element, to, depth);
      }
    }
  };

  const copyElement = (element: Element, to: Node, depth: number): void => {
    const name = element.localName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(name)) return;
    if (depth > MAX_DEPTH || !ALLOWED.has(name)) {
      copyChildren(element, to, depth + 1); // unwrap: keep the text, lose the element
      return;
    }
    if (name === 'img') {
      const image = copyImage(element);
      if (image) to.appendChild(image);
      return;
    }
    const clone = target.createElement(name);
    for (const attribute of [...GLOBAL_ATTRIBUTES, ...(ELEMENT_ATTRIBUTES[name] ?? [])]) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === 'bgcolor') continue; // folded into `style` below
      if (attribute === 'style') continue;
      if (attribute === 'href') {
        if (!isSafeLink(value)) continue;
        clone.setAttribute('href', value.trim());
        clone.setAttribute('target', '_blank');
        clone.setAttribute('rel', 'noopener noreferrer nofollow');
      } else {
        clone.setAttribute(attribute, value);
      }
    }
    const style = styleOfElement(element, name);
    if (style !== '') clone.setAttribute('style', style);
    copyChildren(element, clone, depth + 1);
    to.appendChild(clone);
  };

  copyChildren(source.body, root, 0);
  return {
    html: root.innerHTML,
    blockedImages: blocked,
    contentIds: [...contentIds],
    remoteImageCount: remoteIndex.size,
  };
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text as paragraphs and line breaks (a blank line starts a new paragraph). */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (normalized === '') return '';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Blank lines around these; list items and rows take a single line break. */
const PARAGRAPH_BLOCKS = new Set([
  'p',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
]);
const LINE_BLOCKS = new Set(['div', 'li', 'tr', 'hr']);

/** The plain-text alternative of an HTML fragment: paragraphs, bullets, `> ` for quotes, link targets. */
export function htmlToText(html: string): string {
  const root = parse(html).body;
  let out = '';
  const breakTo = (lines: number): void => {
    if (out === '') return;
    let trailing = 0;
    while (out.endsWith('\n'.repeat(trailing + 1))) trailing += 1;
    if (trailing < lines) out += '\n'.repeat(lines - trailing);
  };
  const walk = (node: Node, list: { n: number; ordered: boolean } | null): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ');
      if (text.trim() !== '' || (text === ' ' && out !== '' && !out.endsWith('\n'))) out += text;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const name = el.localName.toLowerCase();
    if (DROPPED_WITH_CONTENT.has(name)) return;
    if (name === 'br') {
      out += '\n';
      return;
    }
    const gap = PARAGRAPH_BLOCKS.has(name) ? 2 : LINE_BLOCKS.has(name) ? 1 : 0;
    if (gap > 0) breakTo(gap);
    if (name === 'li') out += list?.ordered ? `${String(list.n++)}. ` : '- ';
    const childList = name === 'ul' || name === 'ol' ? { n: 1, ordered: name === 'ol' } : list;
    const mark = out.length;
    for (const child of Array.from(el.childNodes)) walk(child, childList);
    if (name === 'blockquote') {
      const inner = out.slice(mark);
      out =
        out.slice(0, mark) +
        inner
          .trim()
          .split('\n')
          .map((line) => `> ${line}`.trimEnd())
          .join('\n');
    }
    if (name === 'a') {
      const href = el.getAttribute('href');
      const label = el.textContent.trim();
      if (href && isSafeLink(href) && href !== label && href !== `mailto:${label}`) {
        out += ` (${href})`;
      }
    }
    if (gap > 0) breakTo(gap);
  };
  walk(root, null);
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The document the iframe shows. The CSP is a second wall behind the sandbox: no script, no network but images. */
export function buildSrcDoc(bodyHtml: string, options: { allowRemoteImages: boolean }): string {
  const images = options.allowRemoteImages
    ? 'img-src data: blob: https: http:'
    : 'img-src data: blob:';
  // The mail canvas is paper-white, like Gmail's, whatever the app theme: senders design for it, and
  // the app's design tokens cannot cross the iframe boundary. Only neutral values are used here.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${images}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><base target="_blank"><style>
html,body{margin:0;padding:0}
body{padding:12px 16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif;color:#202124;background:#fff;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
img[data-blocked],img[data-cid]:not([src]){display:inline-block;min-width:24px;min-height:24px;background:#f1f3f4;outline:1px dashed #9aa0a6}
table{max-width:100%;border-collapse:collapse}
blockquote{margin:0 0 0 .8ex;padding-left:1ex;border-left:1px solid #ccc;color:#5f6368}
pre{white-space:pre-wrap}
a{color:#1a0dab}
</style></head><body>${bodyHtml}</body></html>`;
}
