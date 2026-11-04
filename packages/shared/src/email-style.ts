/**
 * Inline CSS of an email, reduced to a small allow-list (T-171). Used by the server's HTML sanitiser
 * (what is stored and sent) and by the browser's second pass (what is drawn), so both agree on what a
 * `style="..."` may say.
 *
 * It is a rebuild, not a filter: every declaration is parsed, the property must be on the list, and the
 * value must match the narrow grammar of that property. What survives is written out fresh. Nothing can
 * load a resource (`url()`, `image-set()`, `@import`, `src`), run script (`expression()`, `behavior`,
 * `-moz-binding`), pull in a variable (`var()`, `attr()`), take the page over (`position`, `z-index`,
 * `float`, `display`, `opacity`, `visibility`: no overlay, no hidden text) or hide in an escape (`\`).
 * `!important` is dropped so the viewer's frame keeps the last word.
 */

const LENGTH = /^\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|ex|ch|%)?$/;
const LENGTH_STRICT = /^\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|ex|ch|%)$/;
const NUMBER = /^\d{1,2}(?:\.\d{1,3})?$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/-]{1,60}\)$/i;
const NAMED_COLOR = /^[a-z]{3,24}$/i;
const KEYWORD_COLORS = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset']);
const BORDER_STYLES = new Set([
  'none',
  'hidden',
  'solid',
  'dashed',
  'dotted',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
]);
const FONT_SIZE_KEYWORDS = new Set([
  'xx-small',
  'x-small',
  'small',
  'medium',
  'large',
  'x-large',
  'xx-large',
  'smaller',
  'larger',
]);

function isColor(value: string): boolean {
  if (HEX_COLOR.test(value) || FUNCTION_COLOR.test(value)) return true;
  const lower = value.toLowerCase();
  return KEYWORD_COLORS.has(lower) || (NAMED_COLOR.test(value) && !lower.includes('url'));
}

function oneOf(...allowed: string[]): (value: string) => boolean {
  const set = new Set(allowed);
  return (value) => set.has(value.toLowerCase());
}

/** The largest size an email's own formatting may ask for, by unit (T-171a C-9): no page-sized boxes. */
const MAX_BY_UNIT: Readonly<Record<string, number>> = {
  px: 2000,
  pt: 1500,
  em: 125,
  rem: 125,
  ex: 250,
  ch: 250,
  '%': 100,
};

function withinLimit(part: string): boolean {
  const match = /^(\d+(?:\.\d+)?)([a-z%]*)$/i.exec(part);
  if (match === null) return false;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === '') return Number(match[1]) <= 2000;
  const max = MAX_BY_UNIT[unit];
  return max !== undefined && Number(match[1]) <= max;
}

function lengthList(max: number, allowAuto: boolean): (value: string) => boolean {
  return (value) => {
    const parts = value.split(/\s+/);
    if (parts.length < 1 || parts.length > max) return false;
    return parts.every(
      (part) =>
        (LENGTH.test(part) && withinLimit(part)) || (allowAuto && part.toLowerCase() === 'auto'),
    );
  };
}

/** Text the viewer cannot see, or only just: a size under about 6px, in any unit (T-171a C-1). */
function isTinyFontSize(value: string): boolean {
  const match = /^(\d+(?:\.\d+)?)([a-z%]+)$/i.exec(value);
  if (match === null) return false;
  const amount = Number(match[1]);
  switch ((match[2] ?? '').toLowerCase()) {
    case 'px':
      return amount < 6;
    case 'pt':
      return amount < 4.5;
    case 'em':
    case 'rem':
      return amount < 0.4;
    case 'ex':
    case 'ch':
      return amount < 0.7;
    case '%':
      return amount < 40;
    default:
      return false;
  }
}

/** A colour that paints nothing: `transparent`, or an alpha of (almost) zero in any notation. */
function isInvisibleColor(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower === 'transparent') return true;
  const hex = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/.exec(lower);
  if (hex !== null) {
    const alpha =
      hex[1] !== undefined ? parseInt(hex[1] + hex[1], 16) : parseInt(hex[2] ?? 'ff', 16);
    return alpha <= 12;
  }
  const fn = /^(?:rgb|rgba|hsl|hsla)\(([^)]*)\)$/.exec(lower);
  if (fn === null) return false;
  const body = fn[1] ?? '';
  const slash = body.indexOf('/');
  let alphaText: string | undefined;
  if (slash !== -1) {
    alphaText = body.slice(slash + 1).trim();
  } else {
    const commas = body.split(',');
    if (commas.length === 4) alphaText = (commas[3] ?? '').trim();
  }
  if (alphaText === undefined || alphaText === '') return false;
  const alpha = alphaText.endsWith('%') ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  return Number.isFinite(alpha) && alpha <= 0.05;
}

/** Declarations that make text invisible are dropped, so the AI never reads what a person cannot (C-1). */
const HIDING: Readonly<Record<string, (value: string) => boolean>> = {
  'font-size': isTinyFontSize,
  color: isInvisibleColor,
};

function isBorder(value: string): boolean {
  const parts = value.split(/\s+(?![^(]*\))/);
  if (parts.length < 1 || parts.length > 3) return false;
  return parts.every(
    (part) => LENGTH_STRICT.test(part) || BORDER_STYLES.has(part.toLowerCase()) || isColor(part),
  );
}

const FONT_FAMILY = /^[\p{L}\p{N} ,'"_.-]{1,200}$/u;

const VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  color: isColor,
  'background-color': isColor,
  // `background` is accepted only as a plain colour: no images, no gradients.
  background: isColor,
  'font-weight': (v) => oneOf('normal', 'bold', 'bolder', 'lighter')(v) || /^[1-9]00$/.test(v),
  'font-style': oneOf('normal', 'italic', 'oblique'),
  'font-size': (v) => LENGTH_STRICT.test(v) || FONT_SIZE_KEYWORDS.has(v.toLowerCase()),
  'font-family': (v) => FONT_FAMILY.test(v),
  'line-height': (v) => NUMBER.test(v) || LENGTH_STRICT.test(v) || v.toLowerCase() === 'normal',
  'text-align': oneOf('left', 'right', 'center', 'justify', 'start', 'end'),
  'text-decoration': (v) =>
    v.split(/\s+/).every((p) => oneOf('none', 'underline', 'overline', 'line-through')(p)),
  'text-transform': oneOf('none', 'uppercase', 'lowercase', 'capitalize'),
  direction: oneOf('ltr', 'rtl'),
  'vertical-align': oneOf(
    'baseline',
    'top',
    'middle',
    'bottom',
    'text-top',
    'text-bottom',
    'sub',
    'super',
  ),
  'white-space': oneOf('normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line'),
  'list-style-type': oneOf(
    'disc',
    'circle',
    'square',
    'decimal',
    'lower-alpha',
    'upper-alpha',
    'lower-roman',
    'upper-roman',
    'none',
  ),
  'border-collapse': oneOf('collapse', 'separate'),
  'border-spacing': lengthList(2, false),
  margin: lengthList(4, true),
  'margin-top': lengthList(1, true),
  'margin-right': lengthList(1, true),
  'margin-bottom': lengthList(1, true),
  'margin-left': lengthList(1, true),
  padding: lengthList(4, false),
  'padding-top': lengthList(1, false),
  'padding-right': lengthList(1, false),
  'padding-bottom': lengthList(1, false),
  'padding-left': lengthList(1, false),
  width: lengthList(1, true),
  height: lengthList(1, true),
  'max-width': lengthList(1, true),
  'min-width': lengthList(1, false),
  'max-height': lengthList(1, true),
  'min-height': lengthList(1, false),
  border: isBorder,
  'border-top': isBorder,
  'border-right': isBorder,
  'border-bottom': isBorder,
  'border-left': isBorder,
  'border-color': (v) => v.split(/\s+(?![^(]*\))/).every(isColor),
  'border-width': lengthList(4, false),
  'border-style': (v) => v.split(/\s+/).every((p) => BORDER_STYLES.has(p.toLowerCase())),
  'border-radius': lengthList(4, false),
};

/** Splits on `;` outside quotes and parentheses. */
function declarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const char of css) {
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/** The longest `style` value looked at; a longer one is not an email's own formatting. */
const MAX_STYLE_LENGTH = 4000;

/**
 * The safe subset of an inline `style` value, as `prop:value;prop:value`, or an empty string when
 * nothing on the list is left.
 */
export function sanitizeInlineStyle(input: string): string {
  if (input.length > MAX_STYLE_LENGTH) return '';
  // Comments could hide a keyword from the checks below ("ur/**/l(").
  const css = input.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ');
  // eslint-disable-next-line no-control-regex -- refusing control characters is the purpose
  if (/[\\<>@{}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(css)) return '';
  const kept = new Map<string, string>();
  for (const declaration of declarations(css)) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/!\s*important\s*$/i, '')
      .trim()
      .replace(/\s+/g, ' ');
    const validate = VALIDATORS[property];
    if (validate === undefined || value === '' || value.length > 200) continue;
    if (/url\s*\(|expression|javascript|behavior|binding|var\s*\(|attr\s*\(|image/i.test(value)) {
      continue;
    }
    if (!validate(value)) continue;
    if (HIDING[property]?.(value) === true) continue;
    kept.set(property, value);
  }
  return [...kept].map(([property, value]) => `${property}:${value}`).join(';');
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text as HTML: escaped, one paragraph per blank-line block, line breaks kept. */
export function plainTextToHtml(text: string): string {
  const escaped = text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
  return escaped
    .split(/\r?\n\s*\r?\n/)
    .map((block) => `<p>${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

/** A legacy colour attribute (`bgcolor`, `color`) as a safe colour, or null. */
export function safeColor(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length <= 60 && isColor(trimmed) ? trimmed : null;
}
