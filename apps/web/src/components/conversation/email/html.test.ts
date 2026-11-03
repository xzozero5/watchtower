import { describe, expect, it } from 'vitest';

import { buildSrcDoc, htmlToText, sanitizeEmailHtml, textToHtml } from './html';

describe('sanitizeEmailHtml', () => {
  it('drops scripts, styles, frames, forms, handlers and style attributes', () => {
    const out = sanitizeEmailHtml(
      '<p style="color:red" onclick="x()">Hi</p><script>alert(1)</script><style>p{}</style>' +
        '<iframe src="https://evil.example"></iframe><form action="/x"><input></form><svg onload="x()"></svg>',
    );
    expect(out.html).toBe('<p>Hi</p>');
  });

  it('keeps only safe link schemes and opens links in a new tab without opener', () => {
    const out = sanitizeEmailHtml(
      '<a href="https://ok.example/a">ok</a><a href="java&#9;script:alert(1)">bad</a><a href="data:text/html,x">bad2</a>',
    );
    expect(out.html).toContain('href="https://ok.example/a"');
    expect(out.html).toContain('rel="noopener noreferrer nofollow"');
    expect(out.html).not.toMatch(/javascript|data:/i);
  });

  it('holds back remote images until the reader allows them', () => {
    const html =
      '<img src="https://t.example/pixel.gif" width="1" height="1"><img src="cid:Logo@x">';
    const held = sanitizeEmailHtml(html);
    expect(held.blockedImages).toBe(1);
    expect(held.html).not.toContain('t.example');
    expect(held.contentIds).toEqual(['logo@x']);
    const shown = sanitizeEmailHtml(html, { allowRemoteImages: true });
    expect(shown.html).toContain('src="https://t.example/pixel.gif"');
    expect(shown.html).toContain('referrerpolicy="no-referrer"');
  });

  it('resolves cid images through the caller and refuses other schemes', () => {
    const out = sanitizeEmailHtml(
      '<img src="cid:a@x"><img src="javascript:alert(1)"><img src="/relative.png"><img src="data:image/svg+xml;base64,AAAA">',
      { resolveCid: (id) => (id === 'a@x' ? 'blob:http://app/1' : null) },
    );
    expect(out.html).toContain('src="blob:http://app/1"');
    expect(out.html.match(/<img/g)).toHaveLength(1);
  });

  it('unwraps unknown elements but keeps their text', () => {
    expect(sanitizeEmailHtml('<custom-tag>kept <b>bold</b></custom-tag>').html).toBe(
      'kept <b>bold</b>',
    );
  });
});

describe('text and html conversion', () => {
  it('turns text into paragraphs with escaped content', () => {
    expect(textToHtml('a <b>\nline two\n\nnext')).toBe('<p>a &lt;b&gt;<br>line two</p><p>next</p>');
  });

  it('turns html into a plain-text alternative with lists, quotes and links', () => {
    const text = htmlToText(
      '<p>Hello <a href="https://x.example">site</a></p><ul><li>one</li><li>two</li></ul><blockquote>old</blockquote>',
    );
    expect(text).toBe('Hello site (https://x.example)\n\n- one\n- two\n\n> old');
  });
});

describe('buildSrcDoc', () => {
  it('forbids scripts and the network except images, and only allows remote images on request', () => {
    const off = buildSrcDoc('<p>x</p>', { allowRemoteImages: false });
    expect(off).toContain("default-src 'none'");
    expect(off).toContain('img-src data: blob:;');
    expect(buildSrcDoc('', { allowRemoteImages: true })).toContain(
      'img-src data: blob: https: http:',
    );
  });
});
