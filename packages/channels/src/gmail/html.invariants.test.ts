import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { sanitizeHtml } from './html.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

// Deterministic generator (mulberry32) so a failure is reproducible.
function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fragments = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//evil.example.net/x.js>',
  '<img src=x onerror=alert(1)>',
  '<img src="cid:a@b" onload="x()">',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href=" data:text/html,<script>1</script>">x</a>',
  '<a href="https://ok.example.com/?q=<b>">ok</a>',
  '<div style="background:url(javascript:1)" class="c" id="i" onclick="1">',
  '<svg><use href="#x"/></svg>',
  '<iframe srcdoc="<script>1</script>">',
  '<style>@import url(//evil.example.net/)</style>',
  '<p onmouseover=alert(1)>',
  '<b><i><u>',
  '</b></i>',
  '</p></div></table>',
  '<table><tr><td colspan="9999999" onclick=1>',
  '<!--',
  '-->',
  '<![CDATA[x]]>',
  '<',
  '>',
  '"',
  "'",
  '&lt;script&gt;',
  '&#60;script&#62;',
  '&amp;',
  'plain text',
  'ข้อความไทย',
  '\u0000',
  '‮',
  '<math><mi xlink:href="javascript:1">x</mi></math>',
  '<form action="//evil.example.net/"><button>go</button></form>',
  '<base href="//evil.example.net/">',
  '<meta http-equiv="refresh" content="0;url=//evil.example.net/">',
  '<link rel="stylesheet" href="//evil.example.net/x.css">',
  '<object data="x"></object>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
];

const ALLOWED_TAGS = new Set(
  'p div span br hr b strong i em u s strike del ins sub sup small ul ol li blockquote pre code h1 h2 h3 h4 h5 h6 table thead tbody tfoot tr td th caption a img'.split(
    ' ',
  ),
);

const ALLOWED_ATTRIBUTES = [
  'href',
  'title',
  'rel',
  'target',
  'src',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'start',
  'dir',
];

function randomInput(random: () => number, maxFragments: number): string {
  const count = 1 + Math.floor(random() * maxFragments);
  let input = '';
  for (let n = 0; n < count; n += 1) {
    input += fragments[Math.floor(random() * fragments.length)] ?? '';
  }
  return input;
}

describe('sanitizeHtml: invariants on random tag soup', () => {
  it('never emits active content, unknown tags or unknown attributes', () => {
    const random = prng(20251031);
    for (let run = 0; run < 400; run += 1) {
      const { html } = sanitizeHtml(randomInput(random, 12));

      for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
        expect(ALLOWED_TAGS.has((match[2] ?? '').toLowerCase()), `tag in ${html}`).toBe(true);
        const attrs = (match[3] ?? '').replace(/="[^"]*"/g, '');
        for (const attr of attrs.split(/\s+/).filter(Boolean)) {
          expect(ALLOWED_ATTRIBUTES, `attribute ${attr} in ${html}`).toContain(attr);
        }
      }
      // Every "<" left is a real tag that was just validated; a "<" in text is escaped.
      expect(html.replace(/<\/?[a-zA-Z][^>]*>/g, '')).not.toContain('<');
      expect(html.toLowerCase()).not.toMatch(
        /javascript:|data:|vbscript:|<script|onerror|onload|onclick/,
      );
      // eslint-disable-next-line no-control-regex -- asserting control characters are gone
      expect(html).not.toMatch(/[\u0000-\u0008‮]/);
    }
  });

  it('is idempotent: sanitising the output changes nothing', () => {
    const random = prng(7);
    for (let run = 0; run < 200; run += 1) {
      const once = sanitizeHtml(randomInput(random, 8)).html;
      expect(sanitizeHtml(once).html).toBe(once);
    }
  });

  it('always returns, even for input made of nothing but tag fragments', () => {
    const random = prng(99);
    for (let run = 0; run < 100; run += 1) {
      expect(() => sanitizeHtml(randomInput(random, 40))).not.toThrow();
    }
  });
});
