import { describe, expect, it } from 'vitest';

import { plainTextToHtml, safeColor, sanitizeInlineStyle } from './email-style.js';

describe('sanitizeInlineStyle', () => {
  it('keeps the formatting a mail client writes', () => {
    expect(
      sanitizeInlineStyle(
        'color: #1A73E8; font-weight:700; text-align:center; font-size:14px; font-family:"Segoe UI", Arial, sans-serif; margin: 0 auto',
      ),
    ).toBe(
      'color:#1A73E8;font-weight:700;text-align:center;font-size:14px;font-family:"Segoe UI", Arial, sans-serif;margin:0 auto',
    );
    expect(
      sanitizeInlineStyle('background-color: rgb(250, 250, 250); border: 1px solid #ccc'),
    ).toBe('background-color:rgb(250, 250, 250);border:1px solid #ccc');
    expect(sanitizeInlineStyle('text-decoration: underline line-through; padding: 4px 8px')).toBe(
      'text-decoration:underline line-through;padding:4px 8px',
    );
  });

  it('drops anything that loads a resource, runs code or takes over the page', () => {
    for (const bad of [
      'background: url(https://track.example/p.gif)',
      'background-image: url(x)',
      'background: red url(x)',
      'width: expression(alert(1))',
      'behavior: url(x.htc)',
      '-moz-binding: url(x)',
      'color: var(--x)',
      'position: fixed',
      'z-index: 9999',
      'display: none',
      'visibility: hidden',
      'opacity: 0',
      'float: left',
      'content: attr(x)',
      'margin: -9999px',
    ]) {
      expect(sanitizeInlineStyle(bad), bad).toBe('');
    }
  });

  it('refuses obfuscation: escapes, comments that split a keyword, braces, markup, control characters', () => {
    for (const bad of [
      'background: u\\72l(x)',
      'background: ur/**/l(x)',
      'color: red; } body { display:none',
      'color: red</style><script>',
      'color: re\u0000d',
      '@import "x"',
    ]) {
      expect(sanitizeInlineStyle(bad), bad).toBe('');
    }
    // A comment between declarations is only removed.
    expect(sanitizeInlineStyle('color: red /* c */; font-weight: bold')).toBe(
      'color:red;font-weight:bold',
    );
  });

  it('keeps the allowed declarations when a bad one sits between them, and drops !important', () => {
    expect(
      sanitizeInlineStyle('color: red; background: url(x); font-style: italic !important'),
    ).toBe('color:red;font-style:italic');
  });

  it('rejects values that do not match the grammar of the property', () => {
    expect(sanitizeInlineStyle('font-size: 99999px')).toBe('');
    expect(sanitizeInlineStyle('color: #12')).toBe('');
    expect(sanitizeInlineStyle('text-align: 3px')).toBe('');
    expect(sanitizeInlineStyle('x'.repeat(5000))).toBe('');
  });
});

describe('safeColor', () => {
  it('accepts colours and nothing else', () => {
    expect(safeColor(' #fff ')).toBe('#fff');
    expect(safeColor('red')).toBe('red');
    expect(safeColor('url(x)')).toBeNull();
    expect(safeColor('red;x:y')).toBeNull();
  });
});

describe('text a person cannot see (T-171a C-1)', () => {
  it('drops tiny font sizes and invisible colours so the text stays readable', () => {
    for (const hidden of [
      'font-size:0px',
      'font-size:1px',
      'font-size:5.9px',
      'font-size:0.1em',
      'font-size:2pt',
      'color:transparent',
      'color:rgb(0 0 0 / 0)',
      'color:rgb(0 0 0 / 0%)',
      'color:rgba(0,0,0,0)',
      'color:hsla(0, 0%, 0%, 0)',
      'color:hsl(0 0% 0% / 0)',
      'color:#0000',
      'color:#00000000',
    ]) {
      expect(sanitizeInlineStyle(`${hidden};font-weight:bold`), hidden).toBe('font-weight:bold');
    }
  });

  it('keeps ordinary sizes and colours', () => {
    expect(sanitizeInlineStyle('font-size:12px;color:rgba(0,0,0,0.8)')).toBe(
      'font-size:12px;color:rgba(0,0,0,0.8)',
    );
    expect(sanitizeInlineStyle('font-size:6px;color:#000000ff')).toBe(
      'font-size:6px;color:#000000ff',
    );
  });
});

describe('size limits (T-171a C-9)', () => {
  it('refuses boxes and margins that would cover the page', () => {
    expect(sanitizeInlineStyle('width:99999px;height:3000px;margin:0 200em')).toBe('');
    expect(sanitizeInlineStyle('width:600px;height:2000px;margin:0 auto')).toBe(
      'width:600px;height:2000px;margin:0 auto',
    );
  });
});

describe('plainTextToHtml', () => {
  it('escapes and wraps paragraphs', () => {
    expect(plainTextToHtml('a <b>\n\nc\nd')).toBe('<p>a &lt;b&gt;</p><p>c<br>d</p>');
  });
});
