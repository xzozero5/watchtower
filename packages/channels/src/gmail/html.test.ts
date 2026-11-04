import { disableNetConnect } from '@watchtower/shared/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { decodeEntities, isSafeHref, sanitizeHtml } from './html.js';

const net = disableNetConnect();
afterAll(() => {
  expect(net.blocked()).toEqual([]);
  net.restore();
});

describe('sanitizeHtml: allow-list rebuild', () => {
  it('keeps basic formatting', () => {
    const { html } = sanitizeHtml(
      '<p>Hi <strong>there</strong><br>line<ul><li>a</li><li>b</li></ul></p>',
    );
    expect(html).toBe('<p>Hi <strong>there</strong><br>line<ul><li>a</li><li>b</li></ul></p>');
  });

  it('unwraps unknown elements and keeps their text', () => {
    const { html } = sanitizeHtml('<o:p>x</o:p><marquee>y</marquee><blink>z</blink>');
    expect(html).toBe('xyz');
  });

  it('writes legacy font, center and bgcolor as a safe style, like Gmail shows them', () => {
    const { html } = sanitizeHtml(
      '<font color="red" face="Arial"><center>text</center></font><table bgcolor="#eee" width="600" border="1"><tr><td align="center" bgcolor="url(x)">c</td></tr></table>',
    );
    expect(html).toBe(
      '<span style="color:red;font-family:Arial"><div style="text-align:center">text</div></span><table border="1" width="600" style="background-color:#eee"><tr><td align="center">c</td></tr></table>',
    );
  });

  it('drops dangerous elements together with their content', () => {
    const { html, text } = sanitizeHtml(
      'a<script>alert(1)</script>b<style>p{}</style>c<iframe>inner</iframe>d<object><p>o</p></object>e<textarea>t</textarea>f',
    );
    expect(html).toBe('abcdef');
    expect(text).toBe('abcdef');
  });

  it('handles nested dropped elements of the same name', () => {
    expect(sanitizeHtml('x<svg><svg>one</svg>two</svg>y').html).toBe('xy');
  });

  it('removes every attribute that is not allow-listed', () => {
    const { html } = sanitizeHtml(
      '<div style="x" class="y" id="z" onclick="e()" data-a="b" dir="rtl">t</div><td colspan="2" style="s">c</td>',
    );
    expect(html).toBe('<div dir="rtl">t</div><td colspan="2">c</td>');
  });

  it('keeps a safe style attribute and rebuilds it through the allow-list', () => {
    const { html } = sanitizeHtml(
      '<p style="color:#123456; font-weight:bold; background:url(https://t.example.net/x.gif); position:fixed">t</p><span style="expression(alert(1))">s</span>',
    );
    expect(html).toBe('<p style="color:#123456;font-weight:bold">t</p><span>s</span>');
  });

  it('escapes text and attribute values', () => {
    const { html } = sanitizeHtml(
      '<p title="a">1 &lt; 2 &amp; 3 > 2 <b>"q"</b></p><a href=\'https://x.example.com/?a="1"&b=2\'>l</a>',
    );
    expect(html).toContain('1 &lt; 2 &amp; 3 &gt; 2');
    expect(html).toContain('href="https://x.example.com/?a=&quot;1&quot;&amp;b=2"');
  });

  it('does not let entities smuggle markup back in', () => {
    const { html } = sanitizeHtml('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('auto-closes unclosed elements and ignores stray close tags', () => {
    expect(sanitizeHtml('<p><b>bold</p></i></b>after').html).toBe('<p><b>bold</b></p>after');
    expect(sanitizeHtml('<div><p>open').html).toBe('<div><p>open</p></div>');
  });

  it('treats a stray "<" as text and drops a truncated tag', () => {
    expect(sanitizeHtml('1 < 2 and <b').html).toBe('1 &lt; 2 and ');
  });

  it('drops comments, doctype and processing instructions', () => {
    const { html } = sanitizeHtml(
      '<!DOCTYPE html><!-- c --><?xml version="1.0"?><p>x</p><!-- unterminated',
    );
    expect(html).toBe('<p>x</p>');
  });

  it('strips control and bidi-override characters from text', () => {
    expect(sanitizeHtml('a\u0000b‮c').html).toBe('abc');
  });

  it('limits nesting depth and output size without throwing', () => {
    const deep = '<div>'.repeat(500) + 'x' + '</div>'.repeat(500);
    expect(() => sanitizeHtml(deep, { maxDepth: 20 })).not.toThrow();
    const big = sanitizeHtml('<p>' + 'a'.repeat(1000) + '</p>', { maxOutputChars: 100 });
    expect(big.truncated).toBe(true);
    expect(big.html.length).toBeLessThanOrEqual(100);
  });
});

describe('sanitizeHtml: links', () => {
  it.each([
    ['https://example.com/a', true],
    ['HTTP://example.com', true],
    ['mailto:a@example.com', true],
    ['tel:+66000000000', true],
    ['javascript:alert(1)', false],
    ['  java\tscript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    ['data:text/html;base64,AAAA', false],
    ['vbscript:x', false],
    ['//evil.example.net/x', false],
    ['/relative', false],
    ['#anchor', false],
    ['', false],
  ])('isSafeHref(%j) is %s', (href, expected) => {
    expect(isSafeHref(href)).toBe(expected);
  });

  it('adds rel and target, and unwraps links with unsafe targets', () => {
    expect(sanitizeHtml('<a href="https://example.com" onclick="x">go</a>').html).toBe(
      '<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">go</a>',
    );
    expect(sanitizeHtml('<a href="javascript:x()">go</a>').html).toBe('go');
  });
});

describe('sanitizeHtml: images', () => {
  it('keeps cid images with safe attributes only', () => {
    const { html, inlineContentIds } = sanitizeHtml(
      '<img src="cid:Logo@Example.com" alt="L&amp;O" width="20" height="abc" onerror="x" style="y">',
    );
    expect(html).toBe('<img src="cid:logo@example.com" alt="L&amp;O" width="20">');
    expect(inlineContentIds).toEqual(['logo@example.com']);
  });

  it('removes remote, data and relative images and counts them', () => {
    const { html, remoteImagesBlocked } = sanitizeHtml(
      '<img src="https://t.example.net/p.gif"><img src="data:image/png;base64,AAAA"><img src="/p.gif"><img>',
    );
    expect(html).toBe('');
    expect(remoteImagesBlocked).toBe(3);
  });

  it('with keepRemoteImages keeps a remote address as inert data-remote-src, never as src', () => {
    const { html, remoteImagesBlocked } = sanitizeHtml(
      '<img src="https://t.example.net/p.gif?a=1&b=2" alt="pic" width="40" onerror="x"><img src="javascript:alert(1)"><img src="http://x.example.net/a&quot;b.gif"><img src="//cdn.example.net/x.gif"><img src="data:image/png;base64,AAAA">',
      { keepRemoteImages: true },
    );
    expect(html).toBe(
      '<img data-remote-src="https://t.example.net/p.gif?a=1&amp;b=2" alt="pic" width="40">',
    );
    expect(html).not.toMatch(/\ssrc=/);
    expect(remoteImagesBlocked).toBe(5);
  });
});

describe('sanitizeHtml: plain-text rendering', () => {
  it('separates blocks and keeps list items on their own line', () => {
    const { text } = sanitizeHtml(
      '<h1>Title</h1><p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>',
    );
    expect(text).toBe('Title\n\nOne\n\nTwo\n\n- a\n- b');
  });

  it('collapses source whitespace but keeps pre-formatted text', () => {
    expect(sanitizeHtml('<p>a \n   b\t c</p>').text).toBe('a b c');
    expect(sanitizeHtml('<pre>a\n  b</pre>').text).toBe('a\n  b');
  });

  it('prefixes quoted replies', () => {
    expect(
      sanitizeHtml('<p>new</p><blockquote><p>old</p><blockquote>older</blockquote></blockquote>')
        .text,
    ).toBe('new\n\n> old\n\n> > older');
  });

  it('shows the link target when it differs from the text, not for mailto', () => {
    expect(sanitizeHtml('<a href="https://example.com/x">docs</a>').text).toBe(
      'docs (https://example.com/x)',
    );
    expect(sanitizeHtml('<a href="https://example.com/x">https://example.com/x</a>').text).toBe(
      'https://example.com/x',
    );
    expect(sanitizeHtml('<a href="mailto:a@example.com">mail</a>').text).toBe('mail');
  });

  it('renders table rows as lines', () => {
    expect(
      sanitizeHtml('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
        .text,
    ).toBe('a b\nc d');
  });

  it('keeps Thai text intact', () => {
    expect(sanitizeHtml('<p>สวัสดี&nbsp;ครับ</p>').text).toBe('สวัสดี ครับ');
  });
});

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('&amp; &lt; &#65; &#x42; &baht; &unknown;')).toBe('& < A B ฿ &unknown;');
  });

  it('replaces invalid code points', () => {
    expect(decodeEntities('&#0; &#xD800; &#1114112;')).toBe('� � �');
  });
});
