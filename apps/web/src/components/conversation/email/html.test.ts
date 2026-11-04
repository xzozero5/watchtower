import { describe, expect, it } from 'vitest';

import { buildSrcDoc, htmlToText, sanitizeEmailHtml, textToHtml } from './html';

describe('sanitizeEmailHtml', () => {
  it('drops scripts, style blocks, frames, forms and handlers', () => {
    const out = sanitizeEmailHtml(
      '<p onclick="x()">Hi</p><script>alert(1)</script><style>p{}</style>' +
        '<iframe src="https://evil.example"></iframe><form action="/x"><input></form><svg onload="x()"></svg>',
    );
    expect(out.html).toBe('<p>Hi</p>');
  });

  it('keeps the safe part of a style attribute, so a mail looks as it does in Gmail', () => {
    const out = sanitizeEmailHtml(
      '<p style="color:#123456;font-weight:bold;background:url(https://t.example/x.gif);position:fixed">Hi</p>' +
        '<table bgcolor="#eeeeee" width="600"><tr><td bgcolor="url(x)" width="50%">c</td></tr></table>',
    );
    expect(out.html).toContain('<p style="color:#123456;font-weight:bold">Hi</p>');
    expect(out.html).toContain('<table width="600" style="background-color:#eeeeee">');
    expect(out.html).not.toMatch(/url\(|position|t\.example/);
    expect(out.html).toContain('<td width="50%">c</td>');
  });

  it('leaves styles out when asked (pasted text keeps words and structure only)', () => {
    expect(sanitizeEmailHtml('<p style="color:red">Hi</p>', { styles: false }).html).toBe(
      '<p>Hi</p>',
    );
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

  it('holds back the inert remote address from the server until the reader allows it', () => {
    const html = '<img data-remote-src="https://t.example/pixel.png" alt="logo" width="40">';
    const held = sanitizeEmailHtml(html);
    expect(held.blockedImages).toBe(1);
    expect(held.html).not.toMatch(/src="https|t\.example/);
    const shown = sanitizeEmailHtml(html, { allowRemoteImages: true });
    expect(shown.blockedImages).toBe(0);
    expect(shown.html).toContain('src="https://t.example/pixel.png"');
    expect(shown.html).not.toContain('data-remote-src');
    // Only http(s) counts: a javascript: address in the inert attribute shows nothing.
    expect(
      sanitizeEmailHtml('<img data-remote-src="javascript:alert(1)">', { allowRemoteImages: true })
        .html,
    ).toBe('');
  });

  it('shows a remote image through a URL the caller gives, numbering them the way the api does (T-175)', () => {
    const html =
      '<p><img data-remote-src="https://a.example/1.png"></p><img src="cid:x@y">' +
      '<img data-remote-src="javascript:alert(1)"><img data-remote-src="https://b.example/2.png">';
    const asked: number[] = [];
    const shown = sanitizeEmailHtml(html, {
      allowRemoteImages: true,
      resolveRemote: (index) => {
        asked.push(index);
        return index === 0 ? 'blob:null/one' : null;
      },
    });
    expect(shown.remoteImageCount).toBe(3); // the unsafe one still takes its place in the count
    expect(asked).toEqual([0, 2]); // the api's position of b.example is 2, not 1
    expect(shown.html).toContain('src="blob:null/one"');
    expect(shown.html).not.toMatch(/a.example|b.example|data-remote-src/);
    expect(shown.html).toContain('data-blocked="1"'); // not loaded yet: a placeholder
    // Nothing is asked for before the reader allows images, and an address in src has no position.
    const held = sanitizeEmailHtml(html, { resolveRemote: () => 'blob:null/never' });
    expect(held.html).not.toContain('blob:null/never');
    const legacy = sanitizeEmailHtml('<img src="https://t.example/p.png">', {
      allowRemoteImages: true,
      resolveRemote: () => 'blob:null/never',
    });
    expect(legacy.html).not.toContain('t.example');
    expect(legacy.html).not.toContain('blob:null/never');
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
